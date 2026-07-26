import { useState, useEffect, useRef } from "react";

const API = "http://localhost:3001";

// Поле выбора человека из базы (с поиском) либо ввода нового / только имени / неизвестного
function PersonPicker({ role, value, onChange, defaultGender }) {
  const [mode, setMode] = useState(value?.mode || "none");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [chosenLabel, setChosenLabel] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const timer = useRef(null);

  useEffect(() => {
    onChange(buildValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, firstName, lastName, chosenLabel]);

  function buildValue() {
    if (mode === "none") return { mode: "none" };
    if (mode === "existing") return value?.id ? { mode: "existing", id: value.id } : { mode: "none" };
    if (mode === "nameonly") return { mode: "nameonly", first_name: firstName };
    if (mode === "new") return { mode: "new", first_name: firstName, last_name: lastName };
    return { mode: "none" };
  }

  function doSearch(q) {
    setQuery(q);
    clearTimeout(timer.current);
    if (q.trim().length < 1) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`);
        setResults(await r.json());
      } catch { setResults([]); }
    }, 250);
  }

  function pick(p) {
    const label = `${p.last_name || ""} ${p.first_name || ""}${p.birth_year ? " (" + p.birth_year + ")" : ""}`.trim();
    setChosenLabel(label);
    setResults([]); setQuery("");
    onChange({ mode: "existing", id: p.id });
  }

  return (
    <div className="pf-picker">
      <div className="pf-role">{role}</div>
      <div className="pf-modes">
        <button type="button" className={mode === "existing" ? "on" : ""} onClick={() => setMode("existing")}>из базы</button>
        <button type="button" className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>новый</button>
        <button type="button" className={mode === "nameonly" ? "on" : ""} onClick={() => setMode("nameonly")}>только имя</button>
        <button type="button" className={mode === "none" ? "on" : ""} onClick={() => setMode("none")}>неизвестен</button>
      </div>

      {mode === "existing" && (
        <div className="pf-search">
          {value?.mode === "existing" && chosenLabel
            ? <div className="pf-chosen">{chosenLabel} <button type="button" onClick={() => { setChosenLabel(""); onChange({ mode: "existing" }); }}>✕</button></div>
            : <>
                <input placeholder="поиск по имени или фамилии…" value={query} onChange={e => doSearch(e.target.value)} />
                {results.length > 0 && (
                  <div className="pf-results">
                    {results.map(p => (
                      <div key={p.id} className="pf-res" onClick={() => pick(p)}>
                        {p.last_name} {p.first_name}{p.birth_year ? ` (${p.birth_year})` : ""}
                        {!p.is_alive ? " · ☾" : ""}
                      </div>
                    ))}
                  </div>
                )}
              </>}
        </div>
      )}
      {mode === "new" && (
        <div className="pf-fields">
          <input placeholder="фамилия" value={lastName} onChange={e => setLastName(e.target.value)} />
          <input placeholder="имя" value={firstName} onChange={e => setFirstName(e.target.value)} />
        </div>
      )}
      {mode === "nameonly" && (
        <div className="pf-fields">
          <input placeholder="имя" value={firstName} onChange={e => setFirstName(e.target.value)} />
        </div>
      )}
      {mode === "none" && <div className="pf-hint">будет отмечено как пробел (дыра) — дозаполнишь позже</div>}
    </div>
  );
}

export default function AddFamily({ onClose, onSaved }) {
  const [father, setFather] = useState({ mode: "none" });
  const [surnameManual, setSurnameManual] = useState("");
  const [clanName, setClanName] = useState("Курджиевы");
  const [mothers, setMothers] = useState([
    { mother: { mode: "none" }, relation: "none", children: [{ first_name: "", gender: "m", is_alive: false, birth_year: "" }] },
  ]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState(null); // предупреждение о дублях

  function setMother(i, patch) {
    setMothers(ms => ms.map((m, k) => k === i ? { ...m, ...patch } : m));
  }
  function addMother() {
    setMothers(ms => [...ms, { mother: { mode: "none" }, relation: "none", children: [{ first_name: "", gender: "m", is_alive: false, birth_year: "" }] }]);
  }
  function removeMother(i) {
    setMothers(ms => ms.length > 1 ? ms.filter((_, k) => k !== i) : ms);
  }
  function setChild(mi, ci, patch) {
    setMothers(ms => ms.map((m, k) => k !== mi ? m : { ...m, children: m.children.map((c, j) => j === ci ? { ...c, ...patch } : c) }));
  }
  function addChild(mi) {
    setMothers(ms => ms.map((m, k) => k !== mi ? m : { ...m, children: [...m.children, { first_name: "", gender: "m", is_alive: false, birth_year: "" }] }));
  }
  function removeChild(mi, ci) {
    setMothers(ms => ms.map((m, k) => k !== mi ? m : { ...m, children: m.children.length > 1 ? m.children.filter((_, j) => j !== ci) : m.children }));
  }

  function buildPayload(force) {
    return {
      force: !!force,
      clanName: clanName.trim() || null,
      surnameManual: surnameManual.trim() || null,
      father,
      mothers: mothers.map(m => ({
        mother: m.mother,
        relation: m.relation,
        children: m.children
          .filter(c => c.first_name.trim())
          .map(c => ({ first_name: c.first_name.trim(), gender: c.gender, is_alive: c.is_alive, birth_year: c.birth_year ? Number(c.birth_year) : null })),
      })),
    };
  }

  async function send(force) {
    setSaving(true); setMsg(""); setConfirm(null);
    try {
      const r = await fetch(`${API}/api/family`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload(force)),
      });
      const res = await r.json();
      if (res.ok) { setMsg(`Готово! Добавлено детей: ${res.childrenCount}`); onSaved && onSaved(); }
      else if (res.needConfirm) { setConfirm(res.warnings); }
      else setMsg("Ошибка: " + (res.error || "не удалось сохранить"));
    } catch (e) { setMsg("Ошибка связи с сервером: " + e.message); }
    setSaving(false);
  }

  async function save() {
    const anyChild = mothers.some(m => m.children.some(c => c.first_name.trim()));
    if (!anyChild) { setMsg("Добавь хотя бы одного ребёнка с именем."); return; }
    send(false);
  }

  return (
    <div className="af-overlay" onClick={onClose}>
      <div className="af-panel" onClick={e => e.stopPropagation()}>
        <div className="af-head">
          <h2>Добавить семью</h2>
          <button className="af-x" onClick={onClose}>✕</button>
        </div>

        <div className="af-section">
          <div className="af-label">Отец</div>
          <PersonPicker role="глава семьи" value={father} onChange={setFather} defaultGender="m" />
        </div>

        <div className="af-row2">
          <label>Фамилия детей<input value={surnameManual} onChange={e => setSurnameManual(e.target.value)} placeholder="если отец не из базы" /></label>
          <label>Род<input value={clanName} onChange={e => setClanName(e.target.value)} placeholder="напр. Курджиевы" /></label>
        </div>

        {mothers.map((m, mi) => (
          <div className="af-mother" key={mi}>
            <div className="af-mother-head">
              <span>Мать {mothers.length > 1 ? `#${mi + 1}` : ""}</span>
              {mothers.length > 1 && <button className="af-remove" onClick={() => removeMother(mi)}>убрать мать</button>}
            </div>
            <PersonPicker role="мать детей" value={m.mother} onChange={v => setMother(mi, { mother: v })} defaultGender="f" />
            <div className="af-relation">
              отношения с отцом:
              <select value={m.relation} onChange={e => setMother(mi, { relation: e.target.value })}>
                <option value="none">не указывать</option>
                <option value="married">в браке</option>
                <option value="divorced">в разводе</option>
              </select>
            </div>

            <div className="af-children">
              <div className="af-children-title">Дети</div>
              {m.children.map((c, ci) => (
                <div className="af-child" key={ci}>
                  <input className="af-cname" placeholder="имя" value={c.first_name} onChange={e => setChild(mi, ci, { first_name: e.target.value })} />
                  <select value={c.gender} onChange={e => setChild(mi, ci, { gender: e.target.value })}>
                    <option value="m">муж</option><option value="f">жен</option>
                  </select>
                  <input className="af-cyear" placeholder="год" value={c.birth_year} onChange={e => setChild(mi, ci, { birth_year: e.target.value })} />
                  <label className="af-alive"><input type="checkbox" checked={!c.is_alive} onChange={e => setChild(mi, ci, { is_alive: !e.target.checked })} />☾</label>
                  {m.children.length > 1 && <button className="af-remove" onClick={() => removeChild(mi, ci)}>✕</button>}
                </div>
              ))}
              <button className="af-add-child" onClick={() => addChild(mi)}>+ ребёнок</button>
            </div>
          </div>
        ))}

        <button className="af-add-mother" onClick={addMother}>+ добавить мать (сводные дети)</button>

        {confirm && (
          <div className="af-confirm">
            <div className="af-confirm-title">⚠ Возможно, эти люди уже есть:</div>
            {confirm.map((w, i) => (
              <div key={i} className="af-confirm-row">
                добавляешь «{w.adding}» — а в базе уже есть «{w.existing}{w.year ? ` (${w.year})` : ""}» у того же родителя
              </div>
            ))}
            <div className="af-confirm-actions">
              <button className="af-confirm-yes" onClick={() => send(true)}>Всё равно добавить (это другие люди)</button>
              <button className="af-confirm-no" onClick={() => setConfirm(null)}>Отмена, проверю</button>
            </div>
          </div>
        )}
        {msg && <div className="af-msg">{msg}</div>}
        <div className="af-actions">
          <button className="af-save" onClick={save} disabled={saving}>{saving ? "Сохраняю…" : "Сохранить семью"}</button>
          <button className="af-cancel" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}