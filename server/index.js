// Сервер-посредник «Пульс Нации»: читает и записывает людей и связи
import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const { Pool } = pg;

// Подключение к базе. Пароль и адрес берутся из .env, наружу не видны.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(process.env.DB_SSL_CA).toString(),
  },
});

const app = express();
app.use(cors());
app.use(express.json()); // разрешаем серверу читать JSON из тела запросов (для формы)

// Проверочный адрес: открыв его, убедимся что сервер жив
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT count(*) AS people FROM people");
    res.json({ ok: true, people: Number(r.rows[0].people) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Отдаёт всех людей и все связи для космоса
app.get("/api/graph", async (req, res) => {
  try {
    const people = await pool.query(`
      SELECT id, last_name, first_name, patronymic, maiden_name,
             gender, birth_year, death_year, is_alive, clan_id
      FROM people ORDER BY id
    `);
    const rels = await pool.query(`
      SELECT person_a, person_b, kind, status
      FROM relationships
    `);
    res.json({ people: people.rows, relationships: rels.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Поиск людей по имени/фамилии — для выбора родителей в форме
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    if (q.length < 1) { res.json([]); return; }
    const r = await pool.query(
      `SELECT id, last_name, first_name, patronymic, gender, birth_year, is_alive
       FROM people
       WHERE lower(first_name) LIKE $1
          OR lower(last_name) LIKE $1
          OR lower(last_name || ' ' || first_name) LIKE $1
       ORDER BY last_name, first_name
       LIMIT 20`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Нормализация имени для поиска похожих (Султан≈Солтан, регистр, дефисы)
function normName(s) {
  if (!s) return "";
  return s.toLowerCase().trim()
    .replace(/[ё]/g, "е")
    .replace(/о/g, "у")      // Солтан → султан (частая вариативность о/у)
    .replace(/[-\s]+/g, "");
}
// Похожи ли имена: точное совпадение нормализованных ИЛИ одно входит в другое
function similarNames(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

// ============ ЗАПИСЬ СЕМЬИ ============
// Принимает «гнездо»: отца и группы матерей с детьми, всё записывает разом.
// Формат тела запроса (JSON):
// {
//   clanName: "Курджиевы" | null,        // род (для наследования); если null — берём от отца
//   father: { mode, id?, first_name?, last_name?, patronymic? },  // mode: 'existing'|'new'|'nameonly'|'none'
//   surnameManual: "Курджиев" | null,    // фамилия вручную, если отца нет/только имя
//   mothers: [                            // одна или несколько матерей
//     {
//       mother: { mode, id?, first_name?, last_name? },  // mode: 'existing'|'new'|'nameonly'|'none'
//       relation: 'married'|'divorced'|'none',           // отношения с отцом
//       children: [ { first_name, gender, is_alive, birth_year? }, ... ]
//     }, ...
//   ]
// }
app.post("/api/family", async (req, res) => {
  const client = await pool.connect();
  try {
    const data = req.body;

    // --- проверка на возможные дубли (если не форсировано) ---
    if (!data.force) {
      const warnings = [];
      // собираем id существующих отцов/матерей, к детям которых добавляем
      const parentIds = [];
      if (data.father && data.father.mode === "existing" && data.father.id) parentIds.push(data.father.id);
      for (const g of (data.mothers || [])) {
        if (g.mother && g.mother.mode === "existing" && g.mother.id) parentIds.push(g.mother.id);
      }
      // имена детей, которых собираемся добавить
      const newNames = [];
      for (const g of (data.mothers || [])) for (const c of (g.children || [])) if (c.first_name) newNames.push(c.first_name);
      // существующие дети этих родителей
      if (parentIds.length && newNames.length) {
        const ex = await pool.query(
          `SELECT DISTINCT p.id, p.first_name, p.birth_year
           FROM people p JOIN relationships r ON r.person_b = p.id
           WHERE r.kind='parent' AND r.person_a = ANY($1)`,
          [parentIds]
        );
        for (const nm of newNames) {
          for (const row of ex.rows) {
            if (similarNames(nm, row.first_name)) {
              warnings.push({ adding: nm, existing: row.first_name, id: row.id, year: row.birth_year });
            }
          }
        }
      }
      if (warnings.length) {
        res.json({ ok: false, needConfirm: true, warnings });
        return;
      }
    }

    await client.query("BEGIN"); // всё внесётся целиком или ничего (безопасность)

    // --- определяем/создаём род ---
    let clanId = null;
    if (data.clanName) {
      const c = await client.query(
        `INSERT INTO clans (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [data.clanName]
      );
      clanId = c.rows[0].id;
    }

    // помощник: создать человека, вернуть id
    async function createPerson(p) {
      // если указана полная дата, а год пуст — берём год из даты (для публичного показа)
      const byear = p.birth_year || (p.birth_date ? Number(String(p.birth_date).slice(0, 4)) : null);
      const dyear = p.death_year || (p.death_date ? Number(String(p.death_date).slice(0, 4)) : null);
      const r = await client.query(
        `INSERT INTO people (last_name, first_name, patronymic, gender, is_alive,
                             birth_year, birth_date, death_year, death_date, clan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.last_name || null, p.first_name || null, p.patronymic || null,
         p.gender || 'm', p.is_alive ?? true, byear || null,
         p.birth_date || null, dyear || null, p.death_date || null, clanId]
      );
      return r.rows[0].id;
    }

    // помощник: получить id родителя по его режиму
    async function resolveParent(spec, defaultGender, defaultSurname) {
      if (!spec || spec.mode === 'none') return null;         // неизвестен → дыра
      if (spec.mode === 'existing') return spec.id;           // выбран из базы
      // 'new' или 'nameonly' → создаём карточку
      return await createPerson({
        last_name: spec.last_name || defaultSurname || null,
        first_name: spec.first_name || null,
        patronymic: spec.patronymic || null,
        gender: defaultGender,
        is_alive: spec.is_alive ?? true,
        birth_year: spec.birth_year || null,
        birth_date: spec.birth_date || null,
        death_year: spec.death_year || null,
        death_date: spec.death_date || null,
      });
    }

    // помощник: имя человека по id (для отчества, если отец выбран из базы)
    async function firstNameOf(id) {
      if (!id) return null;
      const r = await client.query(`SELECT first_name, last_name FROM people WHERE id=$1`, [id]);
      return r.rows[0] || null;
    }

    // --- отец ---
    const fatherSurname = data.surnameManual || null;
    const fatherId = await resolveParent(data.father, 'm', fatherSurname);

    // определяем имя отца (для отчества) и фамилию (для наследования детьми)
    let fatherFirstName = null, inheritedSurname = data.surnameManual || null;
    if (data.father && data.father.mode === 'existing') {
      const info = await firstNameOf(fatherId);
      if (info) { fatherFirstName = info.first_name; if (!inheritedSurname) inheritedSurname = info.last_name; }
    } else if (data.father && (data.father.mode === 'new' || data.father.mode === 'nameonly')) {
      fatherFirstName = data.father.first_name || null;
      if (!inheritedSurname) inheritedSurname = data.father.last_name || null;
    }

    // образование отчества от имени отца
    function makePatronymic(firstName, gender) {
      if (!firstName) return null;
      // упрощённо: муж +ович, жен +овна. Спорные случаи правятся вручную позже.
      const base = firstName.trim();
      return gender === 'f' ? base + 'овна' : base + 'ович';
    }

    const createdChildren = [];

    // --- проходим по каждой матери и её детям ---
    for (const group of (data.mothers || [])) {
      const motherId = await resolveParent(group.mother, 'f', null);

      // брачная нить между отцом и матерью — только если 'married'
      if (fatherId && motherId && group.relation === 'married') {
        await client.query(
          `INSERT INTO relationships (person_a, person_b, kind, status)
           VALUES ($1,$2,'spouse','active')
           ON CONFLICT (person_a, person_b, kind) DO NOTHING`,
          [fatherId, motherId]
        );
      }

      // дети этой матери
      for (const ch of (group.children || [])) {
        const childSurname = (ch.gender === 'f')
          ? (inheritedSurname ? inheritedSurname : null)  // фамилию женщин оставляем как есть (девичья от отца)
          : inheritedSurname;
        const childId = await createPerson({
          last_name: childSurname,
          first_name: ch.first_name,
          patronymic: makePatronymic(fatherFirstName, ch.gender),
          gender: ch.gender,
          is_alive: ch.is_alive ?? true,
          birth_year: ch.birth_year || null,
          birth_date: ch.birth_date || null,
          death_year: ch.death_year || null,
          death_date: ch.death_date || null,
        });
        createdChildren.push(childId);

        // связи родитель→ребёнок (к отцу и к матери, если они есть)
        if (fatherId) await client.query(
          `INSERT INTO relationships (person_a, person_b, kind) VALUES ($1,$2,'parent')
           ON CONFLICT (person_a, person_b, kind) DO NOTHING`, [fatherId, childId]);
        if (motherId) await client.query(
          `INSERT INTO relationships (person_a, person_b, kind) VALUES ($1,$2,'parent')
           ON CONFLICT (person_a, person_b, kind) DO NOTHING`, [motherId, childId]);
      }
    }

    await client.query("COMMIT");
    res.json({ ok: true, fatherId, childrenCount: createdChildren.length });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// ============ УДАЛЕНИЕ ЧЕЛОВЕКА ============
// Удаляет только выбранного человека. Его связи убираются автоматически
// (в таблице relationships стоит ON DELETE CASCADE). Дети остаются в базе.
app.delete("/api/person/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ ok: false, error: "нет id" }); return; }
    await pool.query("DELETE FROM people WHERE id = $1", [id]);
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер Пульс Нации запущен: http://localhost:${PORT}`);
});