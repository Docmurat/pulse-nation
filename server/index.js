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
             gender, birth_year, death_year, is_alive, clan_id,
             CASE WHEN birth_date IS NOT NULL AND is_alive
                  THEN EXTRACT(YEAR FROM age(birth_date))::int
             END AS age,
             CASE WHEN NOT is_alive AND birth_date IS NOT NULL AND death_date IS NOT NULL
                  THEN EXTRACT(YEAR FROM age(death_date, birth_date))::int
             END AS age_at_death
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

// Поиск людей по имени/фамилии — для выбора родителей в форме.
// К каждому кандидату — подсказка-предок, чтобы различать тёзок:
// дед по отцу → дед по матери → бабушка по отцу → бабушка по матери.
// Деда умеем восстанавливать из отчества родителя (Таубиевич → Таубий).
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    if (q.length < 1) { res.json([]); return; }
    const r = await pool.query(
      `SELECT p.id, p.last_name, p.first_name, p.patronymic, p.gender, p.birth_year, p.is_alive
       FROM people p
       WHERE lower(p.first_name) LIKE $1
          OR lower(p.last_name) LIKE $1
          OR lower(p.last_name || ' ' || p.first_name) LIKE $1
       ORDER BY p.last_name, p.first_name
       LIMIT 20`,
      [`%${q}%`]
    );

    const parentsOf = async (id) => (await pool.query(
      `SELECT p.id, p.first_name, p.patronymic, p.gender
       FROM relationships r JOIN people p ON p.id = r.person_a
       WHERE r.kind = 'parent' AND r.person_b = $1`, [id])).rows;

    for (const row of r.rows) {
      const pars = await parentsOf(row.id);
      const dad = pars.find(x => x.gender === 'm');
      const mom = pars.find(x => x.gender === 'f');
      const dadPars = dad ? await parentsOf(dad.id) : [];
      const momPars = mom ? await parentsOf(mom.id) : [];
      // деды: по связям либо из отчества родителя
      const gfDad = (dadPars.find(x => x.gender === 'm') || {}).first_name
        || (dad && patrRoot(dad.patronymic)) || null;
      const gfMom = (momPars.find(x => x.gender === 'm') || {}).first_name
        || (mom && patrRoot(mom.patronymic)) || null;
      // бабушки: только по связям (из отчеств их не восстановить)
      const gmDad = (dadPars.find(x => x.gender === 'f') || {}).first_name || null;
      const gmMom = (momPars.find(x => x.gender === 'f') || {}).first_name || null;
      if (gfDad)      { row.gp_label = 'дед';     row.gp_name = gfDad; }
      else if (gfMom) { row.gp_label = 'дед';     row.gp_name = gfMom; }
      else if (gmDad) { row.gp_label = 'бабушка'; row.gp_name = gmDad; }
      else if (gmMom) { row.gp_label = 'бабушка'; row.gp_name = gmMom; }
      else            { row.gp_label = null;      row.gp_name = null; }
    }
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ СЛОВАРЬ ИСКЛЮЧЕНИЙ ДЛЯ ОТЧЕСТВ ============
// Имя отца (маленькими буквами) → готовые отчества. Пополнять по мере находок:
// просто дописать строку по образцу и перезапустить сервер.
const PATR_EX = {
  // Русские имена на «-ий» с беглой гласной (общее правило их не берёт):
  "валерий":  { m: "Валериевич",  f: "Валерьевна"  },  // по решению основателя
  "юрий":     { m: "Юрьевич",     f: "Юрьевна"     },
  "василий":  { m: "Васильевич",  f: "Васильевна"  },
  "григорий": { m: "Григорьевич", f: "Григорьевна" },
  "анатолий": { m: "Анатольевич", f: "Анатольевна" },
  "виталий":  { m: "Витальевич",  f: "Витальевна"  },
  "геннадий": { m: "Геннадьевич", f: "Геннадьевна" },
  "аркадий":  { m: "Аркадьевич",  f: "Аркадьевна"  },
  "евгений":  { m: "Евгеньевич",  f: "Евгеньевна"  },
  "дмитрий":  { m: "Дмитриевич",  f: "Дмитриевна"  },
  // Карачаевские имена — закреплены явно (общее правило и так их даёт,
  // но словарь гарантирует, что никакая будущая правка их не сломает):
  "муссабий": { m: "Муссабиевич", f: "Муссабиевна" },
  "таубий":   { m: "Таубиевич",   f: "Таубиевна"   },
  "ханапий":  { m: "Ханапиевич",  f: "Ханапиевна"  },
  "алий":     { m: "Алиевич",     f: "Алиевна"     },
  "али":      { m: "Алиевич",     f: "Алиевна"     },
  "илья":     { m: "Ильич",       f: "Ильинична"   },
  "лука":     { m: "Лукич",       f: "Лукинична"   },
  "фома":     { m: "Фомич",       f: "Фоминична"   },
  "кузьма":   { m: "Кузьмич",     f: "Кузьминична" },
  "никита":   { m: "Никитич",     f: "Никитична"   },
  "савва":    { m: "Саввич",      f: "Саввична"    },
  "лев":      { m: "Львович",     f: "Львовна"     },
  "павел":    { m: "Павлович",    f: "Павловна"    },
  "пётр":     { m: "Петрович",    f: "Петровна"    },
  "петр":     { m: "Петрович",    f: "Петровна"    },
  "яков":     { m: "Яковлевич",   f: "Яковлевна"   },
  "михаил":   { m: "Михайлович",  f: "Михайловна"  },
};

// Имя рода из фамилии: «Курджиев» → «Курджиевы» (нетиповые — как есть)
function pluralizeSurname(s) {
  if (!s) return s;
  return /(ев|ов|ёв|ин|ын)$/i.test(s) ? s + "ы" : s;
}
// Мужская основа фамилии: «Курджиевы»/«Курджиева» → «Курджиев» (для склонения)
function masculinizeSurname(s) {
  if (!s) return s;
  const m = s.match(/^(.*(ев|ов|ёв|ин|ын))(а|ы)$/i);
  return m ? m[1] : s;
}
// Женская форма фамилии: Курджиев → Курджиева (только типовые окончания)
function feminizeSurname(s) {
  if (!s) return s;
  if (/(ев|ов|ёв|ин|ын)$/i.test(s)) return s + "а";
  return s; // нетиповые фамилии не трогаем
}
// Корень отчества: Астекович → Астек, Мусса-Хаджиевна → Мусса-Хаджи
function patrRoot(p) {
  if (!p) return "";
  return p.replace(/(овна|евна|ович|евич)$/i, "");
}
// Образование отчества от имени отца (общая функция: и сохранение, и подсказка форме)
function makePatronymic(firstName, gender) {
  if (!firstName) return null;
  let base = firstName.trim();
  // 1) словарь исключений — главнее всех правил
  const ex = PATR_EX[base.toLowerCase()];
  if (ex) return gender === 'f' ? ex.f : ex.m;
  // 2) общие правила: Таубий → Таубиевич (русские имена на «-ий» — в словаре)
  const last = base.slice(-1).toLowerCase();
  if (last === 'ь' || last === 'й') base = base.slice(0, -1); // Исмаиль → Исмаил-евич
  const vowel = 'аяиуэоеыёю'.includes(base.slice(-1).toLowerCase());
  // на гласную: Мусса-Хаджи → Мусса-Хаджиевич; на согласную: Аубекир → Аубекирович
  const suffM = vowel ? 'евич' : 'ович';
  const suffF = vowel ? 'евна' : 'овна';
  return base + (gender === 'f' ? suffF : suffM);
}
// Нормализация имени для поиска похожих (Султан≈Солтан, регистр, дефисы)
function normName(s) {
  if (!s) return "";
  return s.toLowerCase().trim()
    .replace(/[ё]/g, "е")
    .replace(/о/g, "у")      // Солтан → султан (частая вариативность о/у)
    .replace(/[-\s]+/g, "");
}
// Расстояние редактирования: сколько букв заменить/вставить/убрать,
// чтобы одно слово превратилось в другое (Хосан→Хасан = 1)
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99; // слишком разной длины — не тратим время
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                                  // убрать букву
        cur[j - 1] + 1,                               // вставить букву
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // заменить букву
      );
    }
    prev = cur;
  }
  return prev[n];
}
// Похожи ли имена: совпадение нормализованных, вхождение одного в другое,
// или отличие максимум в одну букву (для имён от 4 букв)
function similarNames(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  if (na.length >= 4 && nb.length >= 4 && na[0] === nb[0] && editDistance(na, nb) <= 1) return true;
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
      for (const g of (data.mothers || [])) for (const c of (g.children || [])) if (c.first_name && !c.existing_id) newNames.push(c.first_name);
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

    // --- род определяется АВТОМАТИЧЕСКИ (по отцу), поля в форме нет ---
    let clanId = null;
    let weakClan = true;          // род «со слов», пока не подтверждён фамилией отца
    let baseSurname = null;       // мужская основа фамилии для наследования
    let clanNameFinal = null;
    let existingFatherInfo = null;
    const surnameManualNorm = masculinizeSurname((data.surnameManual || '').trim()) || null;

    if (data.father && data.father.mode === 'existing' && data.father.id) {
      const r0 = await client.query(
        `SELECT first_name, last_name, clan_id FROM people WHERE id = $1`, [data.father.id]);
      existingFatherInfo = r0.rows[0] || null;
      if (existingFatherInfo) {
        if ((existingFatherInfo.last_name || '').trim()) {
          baseSurname = existingFatherInfo.last_name;
          weakClan = false;                      // фамилия отца известна из базы
        }
        if (existingFatherInfo.clan_id) clanId = existingFatherInfo.clan_id; // род отца — детям
      }
    } else if (data.father && data.father.mode === 'new' && (data.father.last_name || '').trim()) {
      baseSurname = masculinizeSurname(data.father.last_name.trim());
      weakClan = false;                          // фамилию отца ввели явно
    }
    if (!baseSurname) baseSurname = surnameManualNorm; // фамилия «со слов» (weakClan остаётся true)

    if (!clanId && baseSurname) {
      clanNameFinal = pluralizeSurname(baseSurname);
      const c = await client.query(
        `INSERT INTO clans (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [clanNameFinal]
      );
      clanId = c.rows[0].id;
    }

    // помощник: создать человека, вернуть id
    async function createPerson(p) {
      // если указана полная дата, а год пуст — берём год из даты (для публичного показа)
      const byear = p.birth_year || (p.birth_date ? Number(String(p.birth_date).slice(0, 4)) : null);
      const dyear = p.death_year || (p.death_date ? Number(String(p.death_date).slice(0, 4)) : null);
      const r = await client.query(
        `INSERT INTO people (last_name, first_name, patronymic, maiden_name, gender, is_alive,
                             birth_year, birth_date, death_year, death_date, clan_id, clan_unverified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [p.last_name || null, p.first_name || null, p.patronymic || null, p.maiden_name || null,
         p.gender || 'm', p.is_alive ?? true, byear || null,
         p.birth_date || null, dyear || null, p.death_date || null, clanId,
         !!(clanId && weakClan)]
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
        maiden_name: spec.maiden_name || null,
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
    const fatherId = await resolveParent(data.father, 'm', surnameManualNorm);

    // имя отца (для отчества) и фамилия (для наследования детьми)
    let fatherFirstName = null, inheritedSurname = baseSurname;
    if (data.father && data.father.mode === 'existing') {
      if (existingFatherInfo) fatherFirstName = existingFatherInfo.first_name;
    } else if (data.father && (data.father.mode === 'new' || data.father.mode === 'nameonly')) {
      fatherFirstName = data.father.first_name || null;
      if (!inheritedSurname) inheritedSurname = data.father.last_name || null;
    }

    const createdChildren = [];
    const newChildrenInfo = [];   // НОВЫЕ дети (не из базы) — для проверки «не одна ли это семья?»
    const motherIds = [];         // id всех матерей этой семьи — чтобы не путать их с «чужими» родителями
    const fatherUnknownKids = []; // дети, записанные при полностью неизвестном отце
    let anySurnameFromMother = false;

    // --- проходим по каждой матери и её детям ---
    for (const group of (data.mothers || [])) {
      // «взяла фамилию мужа»: своя фамилия становится девичьей, надевается мужняя
      let motherSpec = group.mother;
      if (motherSpec && (motherSpec.mode === 'new' || motherSpec.mode === 'nameonly')
          && group.relation === 'married' && group.take_surname && inheritedSurname) {
        motherSpec = {
          ...motherSpec,
          maiden_name: motherSpec.last_name || null,
          last_name: feminizeSurname(inheritedSurname),
        };
      }
      const motherId = await resolveParent(motherSpec, 'f', null);
      if (motherId) motherIds.push(motherId);

      // --- фамилия для детей ЭТОЙ матери: отец → «со слов» → МАТЬ ---
      // Правило основателя: если про отца не известно ничего совсем,
      // дети носят фамилию матери, а вопросы (отчество, род, сама фамилия)
      // ложатся в очередь на разбор — см. father_unknown ниже.
      let groupSurname = inheritedSurname;
      let surnameFromMother = false;
      if (!groupSurname && !fatherId) {
        let momLast = null;
        if (motherId && motherSpec && motherSpec.mode === 'existing') {
          const rm = await client.query(`SELECT last_name FROM people WHERE id = $1`, [motherId]);
          momLast = (rm.rows[0] && rm.rows[0].last_name) || null;
        } else if (motherSpec && motherSpec.last_name) {
          momLast = motherSpec.last_name.trim() || null;
        }
        if (momLast) { groupSurname = masculinizeSurname(momLast); surnameFromMother = true; }
      }

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
        // ребёнок опознан как уже существующий в базе → карточку не создаём,
        // только добавляем недостающие связи родитель→ребёнок
        if (ch.existing_id) {
          const childId = Number(ch.existing_id);
          createdChildren.push(childId);
          if (fatherId) await client.query(
            `INSERT INTO relationships (person_a, person_b, kind) VALUES ($1,$2,'parent')
             ON CONFLICT (person_a, person_b, kind) DO NOTHING`, [fatherId, childId]);
          if (motherId) await client.query(
            `INSERT INTO relationships (person_a, person_b, kind) VALUES ($1,$2,'parent')
             ON CONFLICT (person_a, person_b, kind) DO NOTHING`, [motherId, childId]);
          continue;
        }
        const childSurname = (ch.gender === 'f')
          ? feminizeSurname(groupSurname)   // дочери: Курджиев → Курджиева
          : groupSurname;
        const childId = await createPerson({
          last_name: childSurname,
          first_name: ch.first_name,
          // отчество из формы (человек его видел и мог поправить) главнее автоматики
          patronymic: (ch.patronymic || "").trim() || makePatronymic(fatherFirstName, ch.gender),
          gender: ch.gender,
          is_alive: ch.is_alive ?? true,
          birth_year: ch.birth_year || null,
          birth_date: ch.birth_date || null,
          death_year: ch.death_year || null,
          death_date: ch.death_date || null,
        });
        createdChildren.push(childId);
        if (!fatherId && !fatherFirstName) {
          fatherUnknownKids.push(childId);
          if (surnameFromMother) anySurnameFromMother = true;
        }
        newChildrenInfo.push({
          id: childId,
          first_name: ch.first_name,
          gender: ch.gender,
          birth_year: ch.birth_year || (ch.birth_date ? Number(String(ch.birth_date).slice(0, 4)) : null),
        });

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

    // род указан, но фамилия отца неизвестна → на проверку
    if (clanId && weakClan) {
      await pool.query(
        `INSERT INTO review_queue (kind, person_id, details) VALUES ('clan_unverified', $1, $2)`,
        [fatherId || createdChildren[0] || null, JSON.stringify({
          clan: clanNameFinal,
          reason: "фамилия отца неизвестна — род записан со слов, требует подтверждения",
          children: createdChildren,
        })]
      ).catch(() => {});
    }

    // отец неизвестен совсем → вопросы модератору: отчество, род, фамилия
    if (fatherUnknownKids.length) {
      await pool.query(
        `INSERT INTO review_queue (kind, person_id, details) VALUES ('father_unknown', $1, $2)`,
        [fatherUnknownKids[0], JSON.stringify({
          reason: "отец неизвестен — про него не записано ничего",
          children: fatherUnknownKids,
          surname: anySurnameFromMother
            ? "фамилия записана по матери — уточнить"
            : (surnameManualNorm ? "фамилия записана со слов" : "фамилия не записана"),
          questions: ["отчество детей?", "род (родословная) по отцу?"],
        })]
      ).catch(() => {});
    }

    // тихая проверка «не одна ли это семья?» — совпадение НЕСКОЛЬКИХ детей
    // с детьми одной существующей семьи. Ничего не сливает, только записка в очередь.
    await checkFamilyOverlap({
      newChildren: newChildrenInfo,
      ourParentIds: [fatherId, ...motherIds].filter(Boolean),
      ourFatherName: fatherFirstName
        ? `${inheritedSurname || ''} ${fatherFirstName}`.trim()
        : null,
    });

    res.json({ ok: true, fatherId, childrenCount: createdChildren.length, childrenIds: createdChildren });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// ============ ПРОВЕРКА «НЕ ОДНА ЛИ ЭТО СЕМЬЯ?» ============
// Каждый ребёнок по отдельности мог не показать плашку (у кандидата «другой» отец),
// но если ДВОЕ И БОЛЕЕ наших новых детей совпали с детьми одной и той же
// СУЩЕСТВУЮЩЕЙ семьи — возможно, это та же семья, записанная дважды
// (например, имя отца указано по-разному: Хасан / Хасанбий).
// АВТОМАТИКА НИЧЕГО НЕ СЛИВАЕТ: случай тихо кладётся в review_queue, решает человек.
async function checkFamilyOverlap({ newChildren, ourParentIds, ourFatherName }) {
  try {
    if (!newChildren || newChildren.length < 2) return; // нужен минимум «брат и сестра»
    const ourIds = new Set([...(ourParentIds || []), ...newChildren.map(c => c.id)]);

    // База небольшая — просматриваем всех (при росте заменим на индексы)
    const all = await pool.query(
      `SELECT id, first_name, last_name, gender, birth_year FROM people`
    );

    // Шаг 1: для каждого нашего нового ребёнка ищем похожих людей среди ЧУЖИХ
    const matches = []; // пары { nc: наш ребёнок, p: похожий человек из базы }
    for (const nc of newChildren) {
      if (!nc.first_name) continue;
      for (const p of all.rows) {
        if (ourIds.has(p.id)) continue;                                    // свои не в счёт
        if (nc.gender && p.gender && nc.gender !== p.gender) continue;     // пол должен совпасть
        if (nc.birth_year && p.birth_year
            && Math.abs(nc.birth_year - p.birth_year) > 3) continue;       // год ±3
        if (!similarNames(nc.first_name, p.first_name)) continue;          // имя похоже
        matches.push({ nc, p });
      }
    }
    if (matches.length < 2) return; // совпал максимум один — обычный тёзка, шум

    // Шаг 2: у каждого похожего берём родителей и группируем по родителю.
    // Один и тот же чужой родитель «собрал» двоих наших детей? Подозрительно.
    const byParent = new Map(); // id родителя → { parent, pairs: Map(наш ребёнок → пара) }
    for (const m of matches) {
      const par = await pool.query(
        `SELECT p.id, p.first_name, p.last_name
         FROM relationships r JOIN people p ON p.id = r.person_a
         WHERE r.kind = 'parent' AND r.person_b = $1`,
        [m.p.id]
      );
      for (const parent of par.rows) {
        if (ourIds.has(parent.id)) continue; // это наш же родитель — не чужая семья
        let g = byParent.get(parent.id);
        if (!g) { g = { parent, pairs: new Map() }; byParent.set(parent.id, g); }
        g.pairs.set(m.nc.id, m); // один наш ребёнок считается один раз на родителя
      }
    }

    // Шаг 3: где двое и больше — записка в очередь на разбор
    for (const g of byParent.values()) {
      if (g.pairs.size < 2) continue;
      const matched = [...g.pairs.values()].map(m => ({
        entered: { id: m.nc.id, name: m.nc.first_name },
        found: {
          id: m.p.id,
          name: `${m.p.last_name || ''} ${m.p.first_name || ''}`.trim(),
          year: m.p.birth_year,
        },
      }));
      await pool.query(
        `INSERT INTO review_queue (kind, person_id, details) VALUES ('family_overlap', $1, $2)`,
        [g.parent.id, JSON.stringify({
          question: "Не одна ли это семья? Совпали несколько детей, но родители записаны разными.",
          entered_father: ourFatherName || null,
          existing_parent: {
            id: g.parent.id,
            name: `${g.parent.last_name || ''} ${g.parent.first_name || ''}`.trim(),
          },
          matched_children: matched,
          note: "Автоматика ничего не сливает. Решение — за модератором.",
        })]
      );
    }
  } catch (e) {
    // проверка не имеет права ломать сохранение семьи
    console.log("Проверка family_overlap пропущена:", e.message);
  }
}

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


// ============ ПРОВЕРКА ОДНОГО ЧЕЛОВЕКА НА ДУБЛИ (по всей базе) ============
// Форма зовёт этот адрес, когда заполнение человека закончено.
// GET /api/patronymic?father=Таубий → { m: "Таубиевич", f: "Таубиевна" }
// Форма подставляет отчества детям сразу, по тем же правилам, что при сохранении.
app.get("/api/patronymic", (req, res) => {
  const father = (req.query.father || "").trim();
  if (!father) { res.json({ m: null, f: null }); return; }
  res.json({ m: makePatronymic(father, 'm'), f: makePatronymic(father, 'f') });
});

// GET /api/check-person?first=Хасан&last=Курджиев&year=1890&gender=m
// Отвечает списком похожих людей из базы + их родителями (для сверки связей).
app.get("/api/check-person", async (req, res) => {
  try {
    const first = (req.query.first || "").trim();
    const last = (req.query.last || "").trim();
    const year = req.query.year ? Number(req.query.year) : null;
    const gender = (req.query.gender || "").trim(); // 'm' / 'f' / ''
    const father = (req.query.father || "").trim(); // имя отца добавляемого (если известно)
    const mother = (req.query.mother || "").trim(); // имя матери добавляемого (если известно)
    if (!first) { res.json({ candidates: [] }); return; }

    // База небольшая — просматриваем всех (при росте заменим на индексы)
    const all = await pool.query(
      `SELECT id, first_name, last_name, patronymic, gender, birth_year, death_year, is_alive
       FROM people`
    );

    const candidates = [];
    for (const p of all.rows) {
      if (!similarNames(first, p.first_name)) continue;          // имя обязано быть похожим
      if (gender && p.gender && gender !== p.gender) continue;   // пол, если известен, должен совпадать
      // фамилия: если указана у обоих — должна быть похожа
      if (last && p.last_name && !similarNames(last, p.last_name)) continue;
      // год: если известен у обоих и разница больше 3 лет — считаем разными людьми
      if (year && p.birth_year && Math.abs(year - p.birth_year) > 3) continue;
      candidates.push(p);
      if (candidates.length >= 8) break; // больше не имеет смысла показывать
    }

    // К каждому кандидату — его родители (для проверки «не одна ли это семья»)
    const out = [];
    for (const c of candidates) {
      const par = await pool.query(
        `SELECT p.id, p.first_name, p.last_name, p.gender
         FROM relationships r JOIN people p ON p.id = r.person_a
         WHERE r.kind = 'parent' AND r.person_b = $1`,
        [c.id]
      );
      // Сверка отцов: если отец добавляемого известен, а у кандидата отец
      // (по связи или по корню отчества) явно другой — это не тот человек.
      if (father) {
        const dadNames = par.rows.filter(x => x.gender === 'm').map(x => x.first_name);
        if (!dadNames.length && c.patronymic) dadNames.push(patrRoot(c.patronymic));
        if (dadNames.length && !dadNames.some(n => similarNames(father, n))) continue;
      }
      // Сверка матерей: если мать добавляемого известна, а у кандидата мать другая — не тот человек
      if (mother) {
        const momNames = par.rows.filter(x => x.gender === 'f').map(x => x.first_name);
        if (momNames.length && !momNames.some(n => similarNames(mother, n))) continue;
      }
      out.push({ ...c, parents: par.rows });
    }
    res.json({ candidates: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ ОЧЕРЕДЬ НА РАЗБОР ============
// Сюда автоматика складывает спорные случаи. Ничего не решает сама.
app.post("/api/review", async (req, res) => {
  try {
    const { kind, person_id, details } = req.body || {};
    if (!kind || !details) { res.status(400).json({ ok: false, error: "нужны kind и details" }); return; }
    const r = await pool.query(
      `INSERT INTO review_queue (kind, person_id, details) VALUES ($1, $2, $3) RETURNING id`,
      [kind, person_id || null, JSON.stringify(details)]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Посмотреть открытые спорные случаи (пока — для админа, позже — кабинет модератора)
app.get("/api/review", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT q.id, q.kind, q.person_id, q.details, q.status, q.created_at,
              p.first_name, p.last_name
       FROM review_queue q LEFT JOIN people p ON p.id = q.person_id
       WHERE q.status = 'open' ORDER BY q.created_at`
    );
    res.json({ items: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер Пульс Нации запущен: http://localhost:${PORT}`);
});