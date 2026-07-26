import { useState, useEffect, useRef } from "react";

const API = "http://localhost:3001";

// ---------- общие помощники ----------
const emptyDates = { birth_year: "", birth_date: "", is_alive: true, death_year: "", death_date: "" };

function datesToPayload(d) {
  return {
    is_alive: d.is_alive,
    birth_year: d.birth_year ? Number(d.birth_year) : null,
    birth_date: d.birth_date || null,
    death_year: !d.is_alive && d.death_year ? Number(d.death_year) : null,
    death_date: !d.is_alive && d.death_date ? d.death_date : null,
  };
}

function personLabel(p) {
  return `${p.last_name || ""} ${p.first_name || ""}${p.birth_year ? " (" + p.birth_year + ")" : ""}`.trim();
}

// Прозвон одного человека по всей базе. Возвращает список похожих (или пустой).
async function checkPerson({ first, last, year, gender, father, mother }) {
  try {
    const params = new URLSearchParams({ first: (first || "").trim() });
    if (last && last.trim()) params.set("last", last.trim());
    if (year) params.set("year", year);
    if (gender) params.set("gender", gender);
    if (father && father.trim()) params.set("father", father.trim());
    if (mother && mother.trim()) params.set("mother", mother.trim());
    const r = await fetch(`${API}/api/check-person?` + params.toString());
    const j = await r.json();
    return j.candidates || [];
  } catch { return []; }
}

// Расхождения введённого с базой → тихо в очередь на разбор (ничего не перетираем)
function reportMismatch(role, entered, c) {
  const diffs = [];
  if (entered.last_name && c.last_name && entered.last_name.trim().toLowerCase() !== c.last_name.trim().toLowerCase())
    diffs.push({ field: "фамилия", entered: entered.last_name.trim(), in_base: c.last_name });
  if (entered.birth_year && c.birth_year && Number(entered.birth_year) !== c.birth_year)
    diffs.push({ field: "год рождения", entered: Number(entered.birth_year), in_base: c.birth_year });
  if (entered.is_alive === false && c.is_alive)
    diffs.push({ field: "жив/умер", entered: "умер", in_base: "жив" });
  if (entered.is_alive === true && !c.is_alive)
    diffs.push({ field: "жив/умер", entered: "жив", in_base: "умер" });
  if (!diffs.length) return;
  fetch(`${API}/api/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "data_mismatch", person_id: c.id, details: { role, entered, diffs } }),
  }).catch(() => {});
}

// Жёлтая плашка с кандидатами: «Да, это он» / «Нет, это другой человек»
function DupPanel({ candidates, onAdopt, onReject }) {
  return (
    <div className="af-confirm">
      <div className="af-confirm-title">⚠ Похоже, такой человек уже есть в базе:</div>
      {candidates.map(c => (
        <div key={c.id} className="af-confirm-row">
          <b>{personLabel(c)}</b>{c.patronymic ? ` ${c.patronymic}` : ""}{!c.is_alive ? " · ☾" : ""}
          {c.parents && c.parents.length > 0 && (
            <span className="af-cand-parents"> — родители: {c.parents.map(p => p.first_name).join(", ")}</span>
          )}
          <div><button className="af-confirm-yes" onClick={() => onAdopt(c)}>Да, это он</button></div>
        </div>
      ))}
      <div className="af-confirm-actions">
        <button className="af-confirm-no" onClick={onReject}>Нет, это другой человек</button>
      </div>
    </div>
  );
}

// ---------- блок дат ----------
function LifeDates({ v, onChange, onDone }) {
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <div className="pf-dates">
      <div className="pf-dates-row">
        <input className="pf-year" placeholder="год рожд." value={v.birth_year} onBlur={onDone}
          onChange={e => set({ birth_year: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
        <input className="pf-date" type="date" title="полная дата рождения (необязательно, приватна)"
          value={v.birth_date} onChange={e => set({ birth_date: e.target.value })} />
        <label className="af-alive" title="отметить, что человек ушёл из жизни">
          <input type="checkbox" checked={!v.is_alive}
            onChange={e => set({ is_alive: !e.target.checked })} />умер ☾
        </label>
      </div>
      {!v.is_alive && (
        <div className="pf-dates-row">
          <input className="pf-year" placeholder="год смерти" value={v.death_year}
            onChange={e => set({ death_year: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
          <input className="pf-date" type="date" title="полная дата смерти (необязательно)"
            value={v.death_date} onChange={e => set({ death_date: e.target.value })} />
        </div>
      )}
    </div>
  );
}

// ---------- выбор человека ----------
function PersonPicker({ role, gender, value, onChange }) {
  const [mode, setMode] = useState(value?.mode || "existing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [chosenLabel, setChosenLabel] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [patr, setPatr] = useState("");
  const [dates, setDates] = useState(emptyDates);
  const [cand, setCand] = useState(null);       // найденные возможные дубли
  const [dismissed, setDismissed] = useState(""); // имя, для которого сказали «не он»
  const timer = useRef(null);

  useEffect(() => {
    onChange(buildValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, firstName, lastName, patr, chosenLabel, dates]);

  function buildValue() {
    if (mode === "none") return { mode: "none" };
    if (mode === "existing") return value?.id ? { mode: "existing", id: value.id, first_name: value.first_name } : { mode: "existing" };
    if (mode === "nameonly") return { mode: "nameonly", first_name: firstName, ...datesToPayload(dates) };
    if (mode === "new") return { mode: "new", first_name: firstName, last_name: lastName, patronymic: patr.trim() || null, ...datesToPayload(dates) };
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
    setChosenLabel(personLabel(p));
    setResults([]); setQuery(""); setCand(null);
    setMode("existing");
    onChange({ mode: "existing", id: p.id, first_name: p.first_name });
  }

  // прозвон дублей: зовётся, когда поле имени/года «отпущено» (человек дозаполнен)
  async function checkDup() {
    if (mode !== "new" && mode !== "nameonly") return;
    const nm = firstName.trim();
    if (nm.length < 3 || nm === dismissed) return;
    const found = await checkPerson({
      first: nm,
      last: mode === "new" ? lastName : "",
      year: dates.birth_year || (dates.birth_date ? dates.birth_date.slice(0, 4) : ""),
      gender,
    });
    setCand(found.length ? found : null);
  }

  function adopt(c) {
    // сообщаем о расхождениях (если есть) — они лягут в очередь на разбор
    reportMismatch(role, { first_name: firstName.trim(), last_name: lastName.trim(), ...datesToPayload(dates) }, c);
    pick(c); // человек остаётся один — тот, что в базе
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
          {value?.mode === "existing" && value?.id && chosenLabel
            ? <div className="pf-chosen">{chosenLabel} <button type="button" onClick={() => { setChosenLabel(""); onChange({ mode: "existing" }); }}>✕</button></div>
            : <>
                <input placeholder="поиск по имени или фамилии…" value={query} onChange={e => doSearch(e.target.value)} />
                {results.length > 0 && (
                  <div className="pf-results">
                    {results.map(p => (
                      <div key={p.id} className="pf-res" onClick={() => pick(p)}>
                        {p.last_name} {p.first_name}{p.patronymic ? ` ${p.patronymic}` : ""}{p.birth_year ? ` (${p.birth_year})` : ""}
                        {!p.is_alive ? " · ☾" : ""}
                        {p.father_name && <span className="pf-res-dad"> · отец: {p.father_name}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </>}
        </div>
      )}
      {(mode === "new" || mode === "nameonly") && (
        <>
          <div className="pf-fields">
            {mode === "new" && <input placeholder="фамилия" value={lastName} onBlur={checkDup} onChange={e => setLastName(e.target.value)} />}
            <input placeholder="имя" value={firstName} onBlur={checkDup} onChange={e => setFirstName(e.target.value)} />
            {mode === "new" && <input placeholder="отчество" value={patr} onChange={e => setPatr(e.target.value)} />}
          </div>
          <LifeDates v={dates} onChange={setDates} onDone={checkDup} />
          {cand && <DupPanel candidates={cand} onAdopt={adopt}
            onReject={() => { setDismissed(firstName.trim()); setCand(null); }} />}
        </>
      )}
      {mode === "none" && <div className="pf-hint">будет отмечено как пробел (дыра) — дозаполнишь позже</div>}
    </div>
  );
}

// ---------- сама форма ----------
const newChild = () => ({ first_name: "", gender: "m", ...emptyDates, existing_id: null, existing_label: "" });

export default function AddFamily({ onClose, onSaved }) {
  const [father, setFather] = useState({ mode: "existing" });
  const [surnameManual, setSurnameManual] = useState("");
  const [mothers, setMothers] = useState([
    { mother: { mode: "existing" }, relation: "none", children: [newChild()] },
  ]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState(null);       // страховочное предупреждение сервера
  const [childDup, setChildDup] = useState({});       // ключ "mi_ci" → кандидаты
  const dismissedRef = useRef({});                    // ключ "mi_ci" → имя, признанное «другим человеком»

  function setMother(i, patch) {
    setMothers(ms => ms.map((m, k) => k === i ? { ...m, ...patch } : m));
  }
  function addMother() {
    checkChildrenOf(mothers.length - 1);
    setMothers(ms => [...ms, { mother: { mode: "existing" }, relation: "none", children: [newChild()] }]);
  }
  function removeMother(i) {
    setMothers(ms => ms.length > 1 ? ms.filter((_, k) => k !== i) : ms);
  }
  function setChild(mi, ci, patch) {
    setMothers(ms => ms.map((m, k) => k !== mi ? m : { ...m, children: m.children.map((c, j) => j === ci ? { ...c, ...patch } : c) }));
  }
  function addChild(mi) {
    const last = mothers[mi].children.length - 1;
    checkChild(mi, last);
    setMothers(ms => ms.map((m, k) => k !== mi ? m : { ...m, children: [...m.children, newChild()] }));
  }
  function removeChild(mi, ci) {
    setMothers(ms => ms.map((m, k) => k !== mi ? m : { ...m, children: m.children.length > 1 ? m.children.filter((_, j) => j !== ci) : m.children }));
    setChildDup(d => { const nd = { ...d }; delete nd[`${mi}_${ci}`]; return nd; });
  }

  // прозвон одного ребёнка; возвращает true, если нашлись кандидаты
  async function checkChild(mi, ci) {
    const c = mothers[mi]?.children[ci];
    if (!c) return false;
    const nm = c.first_name.trim();
    const key = `${mi}_${ci}`;
    if (c.existing_id || nm.length < 3 || dismissedRef.current[key] === nm) return false;
    const year = c.birth_year || (c.birth_date ? c.birth_date.slice(0, 4) : "");
    const found = await checkPerson({ first: nm, last: surnameManual, year, gender: c.gender,
      father: father.first_name || "",
      mother: mothers[mi].mother.first_name || "" });
    setChildDup(d => ({ ...d, [key]: found.length ? found : undefined }));
    return found.length > 0;
  }
  function checkChildrenOf(mi) {
    mothers[mi]?.children.forEach((_, ci) => { checkChild(mi, ci); });
  }
  async function checkAllChildren() {
    let any = false;
    for (let mi = 0; mi < mothers.length; mi++)
      for (let ci = 0; ci < mothers[mi].children.length; ci++)
        if (await checkChild(mi, ci)) any = true;
    return any;
  }

  function adoptChild(mi, ci, c) {
    const entered = mothers[mi].children[ci];
    reportMismatch("ребёнок", { first_name: entered.first_name.trim(), last_name: surnameManual.trim(), ...datesToPayload(entered) }, c);
    setChild(mi, ci, { existing_id: c.id, existing_label: personLabel(c) });
    setChildDup(d => ({ ...d, [`${mi}_${ci}`]: undefined }));
  }
  function rejectChild(mi, ci) {
    dismissedRef.current[`${mi}_${ci}`] = mothers[mi].children[ci].first_name.trim();
    setChildDup(d => ({ ...d, [`${mi}_${ci}`]: undefined }));
  }

  function buildPayload(force) {
    return {
      force: !!force,
      surnameManual: surnameManual.trim() || null,
      father,
      mothers: mothers.map(m => ({
        mother: m.mother,
        relation: m.relation,
        take_surname: !!m.take_surname,
        children: m.children
          .filter(c => c.existing_id || c.first_name.trim())
          .map(c => c.existing_id
            ? { existing_id: c.existing_id, first_name: c.first_name.trim() }
            : { first_name: c.first_name.trim(), gender: c.gender, ...datesToPayload(c) }),
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
      if (res.ok) {
        setMsg(res.childrenCount > 0
          ? `Готово! Детей в семье записано: ${res.childrenCount}`
          : "Готово! Семья сохранена.");
        // записка космосу: после перезагрузки выстроить и приблизить эту семью
        const focusId = res.fatherId || (res.childrenIds && res.childrenIds[0]) || "";
        if (focusId) sessionStorage.setItem("pulse_focus_id", String(focusId));
        onSaved && onSaved();
      }
      else if (res.needConfirm) { setConfirm(res.warnings); }
      else setMsg("Ошибка: " + (res.error || "не удалось сохранить"));
    } catch (e) { setMsg("Ошибка связи с сервером: " + e.message); }
    setSaving(false);
  }

  async function save() {
    // Семья без детей — нормально (могли ещё не успеть): достаточно
    // хотя бы одного реального человека — отца, матери или ребёнка.
    const realPerson = v => !v ? false
      : v.mode === "existing" ? !!v.id
      : (v.mode === "new" || v.mode === "nameonly") ? !!(v.first_name || "").trim()
      : false;
    const anyChild = mothers.some(m => m.children.some(c => c.existing_id || c.first_name.trim()));
    const anyone = anyChild || realPerson(father) || mothers.some(m => realPerson(m.mother));
    if (!anyone) { setMsg("Укажи хотя бы одного человека — отца, мать или ребёнка."); return; }
    setMsg("Проверяю совпадения…");
    const found = await checkAllChildren();
    if (found) { setMsg("Сначала разберись с жёлтыми плашками: это он или другой человек?"); return; }
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
          <PersonPicker role="глава семьи" gender="m" value={father} onChange={setFather} />
        </div>

        <div className="af-row2">
          <label>Фамилия детей<input value={surnameManual} onChange={e => setSurnameManual(e.target.value)} placeholder="в мужском роде: Курджиев (если отец не из базы)" /></label>
        </div>


        {mothers.map((m, mi) => (
          <div className="af-mother" key={mi}>
            <div className="af-mother-head">
              <span>Мать {mothers.length > 1 ? `#${mi + 1}` : ""}</span>
              {mothers.length > 1 && <button className="af-remove" onClick={() => removeMother(mi)}>убрать мать</button>}
            </div>
            <PersonPicker role="мать детей" gender="f" value={m.mother} onChange={v => setMother(mi, { mother: v })} />
            <div className="af-relation">
              отношения с отцом:
              <select value={m.relation} onChange={e => setMother(mi, { relation: e.target.value })}>
                <option value="none">не указывать</option>
                <option value="married">в браке</option>
                <option value="divorced">в разводе</option>
              </select>
            </div>
            {m.relation === "married" && (m.mother.mode === "new" || m.mother.mode === "nameonly") && (
              <label className="af-take-surname">
                <input type="checkbox" checked={!!m.take_surname}
                  onChange={e => setMother(mi, { take_surname: e.target.checked })} />
                взяла фамилию мужа (своя станет девичьей)
              </label>
            )}

            <div className="af-children">
              <div className="af-children-title">Дети</div>
              {m.children.map((c, ci) => (
                <div className="af-childbox" key={ci}>
                  {c.existing_id ? (
                    <div className="pf-chosen">{c.existing_label} · уже в базе, будет привязан
                      <button type="button" onClick={() => setChild(mi, ci, { existing_id: null, existing_label: "" })}>✕</button>
                    </div>
                  ) : (
                    <>
                      <div className="af-child">
                        <input className="af-cname" placeholder="имя" value={c.first_name}
                          onBlur={() => checkChild(mi, ci)}
                          onChange={e => setChild(mi, ci, { first_name: e.target.value })} />
                        <select value={c.gender} onChange={e => setChild(mi, ci, { gender: e.target.value })}>
                          <option value="m">муж</option><option value="f">жен</option>
                        </select>
                        <label className="af-alive" title="отметить, что человек ушёл из жизни">
                          <input type="checkbox" checked={!c.is_alive} onChange={e => setChild(mi, ci, { is_alive: !e.target.checked })} />☾
                        </label>
                        {m.children.length > 1 && <button className="af-remove" onClick={() => removeChild(mi, ci)}>✕</button>}
                      </div>
                      <div className="pf-dates-row af-cdates">
                        <input className="pf-year" placeholder="год рожд." value={c.birth_year}
                          onBlur={() => checkChild(mi, ci)}
                          onChange={e => setChild(mi, ci, { birth_year: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
                        <input className="pf-date" type="date" title="полная дата рождения (необязательно, приватна)"
                          value={c.birth_date} onChange={e => setChild(mi, ci, { birth_date: e.target.value })} />
                        {!c.is_alive && (
                          <>
                            <input className="pf-year" placeholder="год смерти" value={c.death_year}
                              onChange={e => setChild(mi, ci, { death_year: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
                            <input className="pf-date" type="date" title="полная дата смерти (необязательно)"
                              value={c.death_date} onChange={e => setChild(mi, ci, { death_date: e.target.value })} />
                          </>
                        )}
                      </div>
                      {childDup[`${mi}_${ci}`] && (
                        <DupPanel candidates={childDup[`${mi}_${ci}`]}
                          onAdopt={cd => adoptChild(mi, ci, cd)}
                          onReject={() => rejectChild(mi, ci)} />
                      )}
                    </>
                  )}
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