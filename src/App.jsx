import { useEffect, useRef } from "react";
import * as d3 from "d3";
import "./App.css";

export default function App() {
  const canvasRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // ============ ЗАГРУЗКА ДАННЫХ С СЕРВЕРА ============
    async function boot() {
      let raw;
      try {
        const resp = await fetch("http://localhost:3001/api/graph");
        raw = await resp.json();
      } catch {
        showError("Не удалось связаться с сервером. Проверьте, что сервер запущен (node index.js).");
        return;
      }
      if (!raw.people || raw.people.length === 0) {
        showError("База пуста — нет людей для отображения.");
        return;
      }
      run(raw);
    }

    function showError(msg) {
      const note = document.getElementById("note");
      if (note) note.innerHTML = "⚠ " + msg;
    }

    boot();

    // ============ ПОСТРОЕНИЕ ГРАФА ИЗ ДАННЫХ БАЗЫ ============
    function run(raw) {

      // Превращаем записи из базы в формат, который понимает космос.
      const AVA=[["#38B6E8","#1F7FD0"],["#F2A25E","#E07A2C"],["#7BC97F","#3F9C57"],["#B08CE0","#7C5BC7"],["#F08CA0","#D65B7A"]];
      const people = raw.people.map((r, i) => ({
        id: r.id,
        surname: r.last_name,
        name: r.first_name,
        patr: r.patronymic || "",
        maiden: r.maiden_name || null,
        g: r.gender,                       // 'm' / 'f'
        death: r.is_alive ? null : 1,      // не жив → помечаем «ушедший»
        birth: r.birth_year || null,
        clan: r.clan_id || 0,
        photo: false,
        av: AVA[i % AVA.length],
        father: null, mother: null, spouse: null,
      }));
      const byId = new Map(people.map(p => [p.id, p]));

      // Связи из базы → нити + проставляем father/mother/spouse
      const links = [];
      for (const rel of raw.relationships) {
        const a = byId.get(rel.person_a), b = byId.get(rel.person_b);
        if (!a || !b) continue;
        if (rel.kind === "parent") {
          links.push({ source: a.id, target: b.id, type: "parent", recent: false });
          // b — ребёнок; проставим ему родителя по полу
          if (a.g === "f") b.mother = a.id; else b.father = a.id;
        } else if (rel.kind === "spouse") {
          links.push({ source: a.id, target: b.id, type: "spouse", recent: false });
          a.spouse = b.id; b.spouse = a.id;
        }
      }

      const rnd = (() => { let s = 20260726; return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return((t^t>>>14)>>>0)/4294967296; }; })();
      const YEAR = 2026;

      function familyOf(p){
        const s=new Set([p.id]);
        if(p.father!=null)s.add(p.father);
        if(p.mother!=null)s.add(p.mother);
        if(p.spouse!=null)s.add(p.spouse);
        for(const q of people){
          if(q.father===p.id||q.mother===p.id)s.add(q.id);
          if(q!==p&&q.father!=null&&q.father===p.father)s.add(q.id);
        }
        return s;
      }

      /* ================= холст, силы, движение ================= */
      const cv=document.getElementById("cv"),ctx=cv.getContext("2d");
      const dpr=Math.min(window.devicePixelRatio||1,2);
      let W=0,H=0;
      function resize(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;
        cv.style.width=W+"px";cv.style.height=H+"px"}
      resize();addEventListener("resize",resize);

      for(const p of people){
        p.x=(rnd()-.5)*300;
        p.y=(rnd()-.5)*300;
        p.ph=rnd()*6.28; p.ph2=rnd()*6.28;
      }
      const motion=!matchMedia("(prefers-reduced-motion:reduce)").matches;
      const sim=d3.forceSimulation(people)
        .force("link",d3.forceLink(links).id(d=>d.id)
          .distance(l=>l.type==="spouse"?34:60).strength(l=>l.type==="spouse"?1:.5))
        .force("charge",d3.forceManyBody().strength(-120))
        .force("collide",d3.forceCollide(15))
        .force("x",d3.forceX(0).strength(.018))
        .force("y",d3.forceY(0).strength(.018))
        .velocityDecay(.55);
      if(motion)sim.alphaTarget(.03);

      let tf=d3.zoomIdentity.translate(W/2,H/2).scale(1);
      let hovered=null,selected=null,hier=null;

      function nodeAt(mx,my){
        const [x,y]=tf.invert([mx,my]);
        return sim.find(x,y,20/tf.k);
      }
      const zoom=d3.zoom().scaleExtent([.25,8])
        .filter(e=>{
          if(e.type==="wheel")return true;
          if(e.type==="dblclick")return false;
          const pt=d3.pointer(e,cv);
          return !nodeAt(pt[0],pt[1]);
        })
        .on("zoom",e=>{tf=e.transform});
      const drag=d3.drag().container(cv).clickDistance(6)
        .subject(e=>nodeAt(e.x,e.y))
        .on("start",e=>{if(!motion)sim.alphaTarget(.25).restart();e.subject._pin=e.subject.fx!=null})
        .on("drag",e=>{const pt=d3.pointer(e.sourceEvent,cv);const[x,y]=tf.invert(pt);
          e.subject.fx=x;e.subject.fy=y;
          sim.alpha(Math.max(sim.alpha(),.25))})
        .on("end",e=>{if(!motion)sim.alphaTarget(0);
          if(!e.subject._pin&&!(hier&&hier.set.has(e.subject.id))){e.subject.fx=null;e.subject.fy=null}});
      d3.select(cv).call(drag).call(zoom).call(zoom.transform,tf);

      cv.addEventListener("mousemove",e=>{
        hovered=nodeAt(e.offsetX,e.offsetY)||null;
        cv.style.cursor=hovered?"pointer":"grab";
      });
      cv.addEventListener("click",e=>{
        if(e.defaultPrevented)return;
        const p=nodeAt(e.offsetX,e.offsetY);
        if(p)select(p);else deselect();
      });

      /* ---- иерархия семьи: три яруса сверху вниз ---- */
      function buildHier(p){
        clearHier();
        const set=familyOf(p);
        const dad=byId.get(p.father),mom=byId.get(p.mother),sp=byId.get(p.spouse);
        const kids=people.filter(q=>q.father===p.id||q.mother===p.id);
        const sibs=people.filter(q=>q!==p&&q.father!=null&&q.father===p.father);
        const cx=p.x,cy=p.y,DX=46,DY=64;
        const targets=new Map();
        const bsort=(a,b)=>((a.birth||0)-(b.birth||0));
        const row=(arr,y)=>{const w=(arr.length-1)*DX;
          arr.forEach((q,i)=>targets.set(q,[cx-w/2+i*DX,y]))};
        const top=[dad,mom].filter(Boolean);
        const mid=[...sibs,p,...(sp?[sp]:[])];
        row(top,cy-DY);row(mid,cy);row(kids.sort(bsort),cy+DY);
        hier={set,targets};
        sim.alpha(Math.max(sim.alpha(),.3)).restart();
      }
      function clearHier(){
        if(!hier)return;
        for(const q of hier.targets.keys()){q.fx=null;q.fy=null}
        hier=null;
        sim.alpha(Math.max(sim.alpha(),.3)).restart();
      }

      /* ================= отрисовка ================= */
      const cssCache={};
      const css=v=>cssCache[v]||(cssCache[v]=getComputedStyle(document.documentElement).getPropertyValue(v).trim());
      const colorOf=p=>p.death?css("--gone"):p.g==="m"?css("--male"):css("--female");

      const motes=Array.from({length:55},()=>({x:rnd(),y:rnd(),r:rnd()*26+8,vx:(rnd()-.5)*.00006,vy:(rnd()-.5)*.00006,a:rnd()*.05+.03}));

      const roundRect=(x,y,w,h,r)=>{ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);
        ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()};

      ctx.font="600 3.7px 'Segoe UI'";
      for(const p of people){
        p.tw=Math.max(ctx.measureText(p.name).width,ctx.measureText(p.surname).width);
        p.cw=Math.max(26,p.tw+15); p.chh=13.5;
      }

      function drawAvatar(p,x,y,r){
        if(p.photo){
          const g=ctx.createLinearGradient(x-r,y-r,x+r,y+r);
          g.addColorStop(0,p.av[0]);g.addColorStop(1,p.av[1]);
          ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,r,0,6.283);ctx.fill();
          ctx.fillStyle="rgba(255,255,255,.9)";ctx.font=`600 ${r*.95}px 'Segoe UI'`;
          ctx.textAlign="center";ctx.textBaseline="middle";
          ctx.fillText(p.name[0],x,y+r*.06);
        }else{
          ctx.fillStyle="#D5DEE8";ctx.beginPath();ctx.arc(x,y,r,0,6.283);ctx.fill();
          ctx.save();ctx.beginPath();ctx.arc(x,y,r,0,6.283);ctx.clip();
          ctx.fillStyle="#A7B4C4";
          ctx.beginPath();ctx.arc(x,y-r*.28,r*.38,0,6.283);ctx.fill();
          ctx.beginPath();ctx.arc(x,y+r*.95,r*.72,0,6.283);ctx.fill();
          ctx.restore();
        }
      }

      function draw(t){
        if(hier){
          for(const [q,tg] of hier.targets){
            const fx=q.fx==null?q.x:q.fx, fy=q.fy==null?q.y:q.fy;
            q.fx=fx+(tg[0]-fx)*.1; q.fy=fy+(tg[1]-fy)*.1;
          }
          if(sim.alpha()<.08)sim.alpha(.08);
          sim.restart();
        }
        ctx.setTransform(dpr,0,0,dpr,0,0);
        const grd=ctx.createLinearGradient(0,0,0,H);
        grd.addColorStop(0,css("--bg1"));grd.addColorStop(1,css("--bg2"));
        ctx.fillStyle=grd;ctx.fillRect(0,0,W,H);
        for(const m of motes){
          if(motion){m.x=(m.x+m.vx*16+1)%1;m.y=(m.y+m.vy*16+1)%1}
          ctx.globalAlpha=m.a+(motion?.02*Math.sin(t/1800+m.r):0);
          ctx.fillStyle="#FFFFFF";
          ctx.beginPath();ctx.arc(m.x*W,m.y*H,m.r,0,6.283);ctx.fill();
        }
        ctx.globalAlpha=1;
        ctx.fillStyle="rgba(150,175,205,.16)";
        ctx.beginPath();ctx.moveTo(0,H);ctx.lineTo(0,H*.87);ctx.lineTo(W*.30,H*.80);
        ctx.lineTo(W*.42,H*.68);ctx.lineTo(W*.50,H*.76);ctx.lineTo(W*.58,H*.66);
        ctx.lineTo(W*.72,H*.82);ctx.lineTo(W,H*.88);ctx.lineTo(W,H);ctx.closePath();ctx.fill();
        ctx.fillStyle="rgba(170,195,225,.20)";
        ctx.beginPath();ctx.moveTo(0,H);ctx.lineTo(0,H*.93);ctx.lineTo(W*.2,H*.89);
        ctx.lineTo(W*.45,H*.94);ctx.lineTo(W*.75,H*.885);ctx.lineTo(W,H*.93);
        ctx.lineTo(W,H);ctx.closePath();ctx.fill();
        ctx.translate(tf.x,tf.y);ctx.scale(tf.k,tf.k);

        const wob=p=>motion&&!(hier&&hier.set.has(p.id))&&p.fx==null
          ?[p.x+1.6*Math.sin(t/1300+p.ph),p.y+1.6*Math.cos(t/1600+p.ph2)]:[p.x,p.y];
        const P=new Map(people.map(p=>[p.id,wob(p)]));

        const focus=selected||hovered;
        const fam=focus?familyOf(focus):null;

        for(const l of links){
          const [x1,y1]=P.get(l.source.id),[x2,y2]=P.get(l.target.id);
          const inFam=fam&&fam.has(l.source.id)&&fam.has(l.target.id);
          const dimmed=fam&&!inFam;
          ctx.strokeStyle=l.type==="spouse"?"rgba(215,140,60,.45)":css("--thread");
          ctx.lineWidth=(l.type==="spouse"?1.5:1)/Math.sqrt(tf.k);
          ctx.shadowBlur=0;ctx.setLineDash([]);
          ctx.globalAlpha=dimmed?.08:1;
          ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
        }
        ctx.setLineDash([]);ctx.shadowBlur=0;ctx.globalAlpha=1;

        const chipMode=Math.min(1,Math.max(0,(tf.k-1.15)/.45));
        const breath=p=>motion?1+.035*Math.sin(t/900+p.ph):1;

        for(const p of people){
          const [x,y]=P.get(p.id);
          const c=colorOf(p),b=breath(p);
          const dimmed=fam&&!fam.has(p.id);
          ctx.globalAlpha=dimmed?.16:1;

          if(chipMode<1){
            ctx.globalAlpha*= (1-chipMode)||.001;
            if(!p.death){ctx.shadowColor=c;ctx.shadowBlur=10}
            ctx.fillStyle=c;
            roundRect(x-4.5*b,y-4.5*b,9*b,9*b,2.8);ctx.fill();
            ctx.shadowBlur=0;
            ctx.globalAlpha=dimmed?.16:1;
          }
          if(chipMode>0){
            ctx.globalAlpha*=chipMode;
            const w=p.cw*b,h=p.chh*b;
            ctx.shadowColor=p.death?"rgba(90,105,120,.35)":c;
            ctx.shadowBlur=p===focus?16:9;
            ctx.fillStyle=p.death?"#E6EAEF":"rgba(255,255,255,.96)";
            roundRect(x-w/2,y-h/2,w,h,4);ctx.fill();
            ctx.shadowBlur=0;
            ctx.strokeStyle=c;ctx.lineWidth=(p===selected||p===hovered?1.6:.9)/Math.sqrt(tf.k);
            roundRect(x-w/2,y-h/2,w,h,4);ctx.stroke();
            drawAvatar(p,x-w/2+6.4,y,3.9);
            ctx.fillStyle=p.death?"#7A8798":"#22303F";
            ctx.textAlign="left";ctx.textBaseline="middle";
            ctx.font="600 3.7px 'Segoe UI'";
            ctx.fillText(p.name,x-w/2+12,y-2.5);
            ctx.font="3.4px 'Segoe UI'";
            ctx.fillStyle=p.death?"#93A0B0":"#66788C";
            ctx.fillText(p.surname,x-w/2+12,y+2.9);
          }
          ctx.globalAlpha=1;
        }
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);

      /* ================= карточка и поиск ================= */
      const card=document.getElementById("card");

      function lifeStr(p){
        if(p.birth && p.death) return `${p.birth} — ушёл из жизни`;
        if(p.death) return "ушёл из жизни";
        if(p.birth) return `${p.birth} г.р. · ${YEAR-p.birth} лет`;
        return p.g==="f"?"годы жизни неизвестны":"годы жизни неизвестны";
      }
      const relLink=(p,role)=>`<a href="#" data-id="${p.id}">${p.surname} ${p.name} <span>· ${role}</span></a>`;

      function select(p){
        selected=p;buildHier(p);
        const ava=document.getElementById("cAva");
        ava.className="noPhoto";ava.style.background="";ava.textContent="👤";
        document.getElementById("cWho").textContent=`${p.surname} ${p.name} ${p.patr||""}`;
        let sub=lifeStr(p);
        if(p.maiden&&p.maiden!==p.surname)sub+=`<br/>в девичестве — ${p.maiden}`;
        document.getElementById("cSub").innerHTML=sub;
        document.getElementById("clan").innerHTML="";
        let rel="";
        const dad=byId.get(p.father),mom=byId.get(p.mother),sp=byId.get(p.spouse);
        const kids=people.filter(q=>q.father===p.id||q.mother===p.id);
        const sibs=people.filter(q=>q!==p&&q.father!=null&&q.father===p.father);
        if(dad||mom){rel+="<h4>Родители</h4>";if(dad)rel+=relLink(dad,"отец");if(mom)rel+=relLink(mom,"мать")}
        if(sp)rel+="<h4>Супруг"+(p.g==="m"?"а":"")+"</h4>"+relLink(sp,"брак");
        if(kids.length)rel+="<h4>Дети</h4>"+kids.map(k=>relLink(k,k.g==="m"?"сын":"дочь")).join("");
        if(sibs.length)rel+="<h4>Братья и сёстры</h4>"+sibs.map(s=>relLink(s,s.g==="m"?"брат":"сестра")).join("");
        document.getElementById("cRel").innerHTML=rel;
        card.classList.add("on");
      }
      function deselect(){selected=null;clearHier();card.classList.remove("on")}
      card.addEventListener("click",e=>{
        const a=e.target.closest("a[data-id]");
        if(!a)return;e.preventDefault();
        const p=byId.get(+a.dataset.id);select(p);flyTo(p);
      });
      document.getElementById("closeCard").onclick=deselect;

      function flyTo(p){
        const k=Math.max(tf.k,2.2);
        d3.select(cv).transition().duration(900).ease(d3.easeCubicInOut)
          .call(zoom.transform,d3.zoomIdentity.translate(W/2,H/2).scale(k).translate(-p.x,-p.y));
      }
      const search=document.getElementById("search"),hint=document.getElementById("hint");
      search.addEventListener("input",()=>{
        const q=search.value.trim().toLowerCase();
        if(q.length<2){hint.textContent="";return}
        const n=people.filter(p=>(p.surname+" "+p.name+" "+(p.patr||"")).toLowerCase().includes(q)).length;
        hint.textContent=n?`найдено: ${n} — Enter, чтобы перейти`:"никого не найдено";
      });
      search.addEventListener("keydown",e=>{
        if(e.key!=="Enter")return;
        const q=search.value.trim().toLowerCase();
        const p=people.find(p=>(p.surname+" "+p.name+" "+(p.patr||"")).toLowerCase().includes(q));
        if(p){select(p);flyTo(p);search.blur()}
      });
    }

  }, []);

  return (
    <>
      <canvas id="cv" ref={canvasRef}></canvas>
        <div className="hud" id="top">
          <div className="brand">
            <svg className="emblem" width="36" height="36" viewBox="0 0 34 34" fill="none" stroke="#1E9FE0" strokeWidth="1.7">
              <circle cx="17" cy="17" r="14.6"/>
              <path d="M17 5.6 28.4 17 17 28.4 5.6 17Z"/>
              <circle cx="17" cy="17" r="1.9" fill="#1E9FE0" stroke="none"/>
            </svg>
            <div>
            <h1>Пульс <b>Нации</b></h1>
            <p>живой граф народа · данные из базы</p>
            </div>
          </div>
          <div id="searchWrap">
            <input id="search" type="text" placeholder="Найти человека… (Enter)" />
            <div id="hint"></div>
          </div>
        </div>

        <div className="hud" id="legend">
          <div className="lg"><span className="dot" style={{background: 'var(--male)', boxShadow: '0 0 6px var(--male)'}}></span>мужчины</div>
          <div className="lg"><span className="dot" style={{background: 'var(--female)', boxShadow: '0 0 6px var(--female)'}}></span>женщины</div>
          <div className="lg"><span className="dot" style={{background: 'var(--gone)'}}></span>ушедшие</div>
          <div className="lg"><span className="seg" style={{background: 'rgba(70,100,140,.5)'}}></span>нить родства</div>
        </div>

        <div className="hud" id="card">
          <svg id="orn" height="10" width="100%" preserveAspectRatio="none">
            <defs><pattern id="rh" width="16" height="10" patternUnits="userSpaceOnUse">
              <path d="M8 1.5 L13.5 5 L8 8.5 L2.5 5 Z" fill="none" stroke="rgba(232,134,47,.5)" strokeWidth="1"/>
              <circle cx="8" cy="5" r=".8" fill="rgba(30,159,224,.5)"/>
            </pattern></defs>
            <rect width="100%" height="10" fill="url(#rh)"/>
          </svg>
          <button id="closeCard">✕</button>
          <div id="cHead">
            <div id="cAva"></div>
            <div>
              <div className="who" id="cWho"></div>
            </div>
          </div>
          <div className="sub" id="cSub"></div>
          <div id="clan"></div>
          <div id="cRel"></div>
        </div>

        <div className="hud" id="note">колесо — зум · пустое место — перемещение · частицу можно таскать<br/>клик по человеку — карточка и построение семьи по ярусам</div>
    </>
  );
}