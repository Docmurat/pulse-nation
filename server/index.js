// Сервер-посредник «Пульс Нации»: берёт людей и связи из базы, отдаёт браузеру
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

// Проверочный адрес: открыв его, убедимся что сервер жив
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT count(*) AS people FROM people");
    res.json({ ok: true, people: Number(r.rows[0].people) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Главный адрес: отдаёт всех людей и все связи для космоса
app.get("/api/graph", async (req, res) => {
  try {
    const people = await pool.query(`
      SELECT id, last_name, first_name, patronymic, maiden_name,
             gender, birth_year, is_alive, clan_id
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер Пульс Нации запущен: http://localhost:${PORT}`);
});