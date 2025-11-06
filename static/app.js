const PERIODS = ["day","week","month"]; // day: 24 колонок; week: 7x24; month: 30x24

const state = {
	period: "day",
	data: null,
};

// tooltip element
const tooltip = document.createElement('div');
tooltip.id = 'tooltip';
document.body.appendChild(tooltip);

const MSK_TZ = 'Europe/Moscow';
const fmtDateTime = new Intl.DateTimeFormat(undefined, { timeZone: MSK_TZ, day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second: undefined });
const fmtDateTimeFull = new Intl.DateTimeFormat(undefined, { timeZone: MSK_TZ, day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
const fmtDateOnly = new Intl.DateTimeFormat(undefined, { timeZone: MSK_TZ, day:'2-digit', month:'2-digit' });
const fmtHourOnly = new Intl.DateTimeFormat(undefined, { timeZone: MSK_TZ, hour:'2-digit' });
const mskHourFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK_TZ, hour:'2-digit', hourCycle:'h23' });

const SHIFT_CELLS = 4; // shift cells right by 4 positions
const SHIFT_TOOLTIP = SHIFT_CELLS - 2; // tooltip shows time 2 hours back relative to cells

function getMskHour(ts){
	const parts = mskHourFmt.formatToParts(new Date(ts*1000));
	const hour = parts.find(p=>p.type==='hour');
	return hour ? parseInt(hour.value, 10) : 0; // 0..23
}

function classForRatio(r){
	if(r==null) return 'none';
	if(r>=0.99) return 'good';
	if(r>=0.80) return 'ok';
	if(r>=0.50) return 'warn';
	return 'bad';
}

function fmtHour(ts){
	const d = new Date(ts*1000);
	return fmtDateTime.format(d);
}

function hourRange(ts){
	const start = new Date(ts*1000);
	const end = new Date((ts+3599)*1000);
	return `${fmtDateTimeFull.format(start)} — ${fmtDateTimeFull.format(end)} МСК`;
}

function hourRangeShifted(ts){
	const start = new Date(ts*1000);
	const end = new Date((ts+3599)*1000);
	const startShifted = new Date(start.getTime() + SHIFT_TOOLTIP * 3600 * 1000);
	const endShifted = new Date(end.getTime() + SHIFT_TOOLTIP * 3600 * 1000);
	return `${fmtDateTimeFull.format(startShifted)} — ${fmtDateTimeFull.format(endShifted)} МСК`;
}

function setActive(period){
	document.querySelectorAll('.btn').forEach(b=>{
		b.classList.toggle('active', b.dataset.period===period);
	});
}

async function loadData(){
	const list = document.getElementById('list');
	if(list) list.classList.add('loading');
	const res = await fetch(`/api/uptime?period=${state.period}`);
	state.data = await res.json();
	if(list) list.classList.remove('loading');
}

function render(){
	const list = document.getElementById('list');
	list.innerHTML = '';

	Object.entries(state.data).forEach(([name, payload])=>{
		const tpl = document.getElementById('server-row');
		const node = tpl.content.cloneNode(true);

		node.querySelector('[data-name]').textContent = name;
		const pill = node.querySelector('[data-uptime]');
		const newValue = payload.uptime_percent==null ? '—' : `${payload.uptime_percent.toFixed(0)}%`;
		if(pill.textContent !== newValue){
			pill.style.transform = 'scale(1.1)';
			setTimeout(()=>{
				pill.textContent = newValue;
				pill.style.transition = 'transform 0.3s ease';
				pill.style.transform = 'scale(1)';
			}, 150);
		} else {
			pill.textContent = newValue;
		}

		const grid = node.querySelector('[data-grid]');
		grid.classList.add(state.period);

		const series = payload.series; // уже в порядке для выбранного периода

		if(state.period === 'day'){
			const first24 = series.slice(0,24);
			const slots = new Array(24).fill(null);
			first24.forEach(p=>{
				const h = getMskHour(p.hour); // 0..23
				const idx = (h + SHIFT_CELLS) % 24;
				slots[idx] = p;
			});
			for(let i=0;i<24;i++){
				const point = slots[i] || { hour: 0, ok_ratio: null };
				const div = document.createElement('div');
				div.className = 'cell ' + classForRatio(point.ok_ratio);
				div.dataset.kind = 'hour';
				div.dataset.ts = String(point.hour);
				div.dataset.ok = point.ok_ratio==null ? '' : String(point.ok_ratio);
				div.dataset.server = name;
				div.style.opacity = '0';
				div.style.transform = 'scale(0.8)';
				div.addEventListener('mouseenter', onCellEnter);
				div.addEventListener('mousemove', onCellMove);
				div.addEventListener('mouseleave', onCellLeave);
				grid.appendChild(div);
				setTimeout(()=>{
					div.style.transition = 'all 0.3s cubic-bezier(0.4,0,0.2,1)';
					div.style.opacity = '1';
					div.style.transform = 'scale(1)';
				}, i * 15);
			}
			const hoursEl = node.querySelector('[data-hours]');
			hoursEl.innerHTML = '';
			for(let h=0; h<24; h++){
				const s = document.createElement('span');
				s.textContent = String(h).padStart(2,'0');
				hoursEl.appendChild(s);
			}
			const first = first24[0];
			const last = first24[first24.length-1];
			node.querySelector('[data-start]').textContent = fmtDateTimeFull.format(new Date(first.hour*1000)) + ' МСК';
			node.querySelector('[data-end]').textContent = fmtDateTimeFull.format(new Date(last.hour*1000)) + ' МСК';
		} else {
			// aggregate per day
			const dayMap = new Map(); // key -> {sum, cnt, ts}
			series.forEach(p=>{
				const d = new Date(p.hour*1000);
				const key = new Intl.DateTimeFormat('en-CA',{ timeZone: MSK_TZ, year:'numeric', month:'2-digit', day:'2-digit'}).format(d); // YYYY-MM-DD
				if(!dayMap.has(key)) dayMap.set(key,{sum:0,cnt:0,ts:Date.parse(key+'T00:00:00Z')});
				if(p.ok_ratio!=null){
					const entry = dayMap.get(key);
					entry.sum += p.ok_ratio;
					entry.cnt += 1;
				}
			});
			const days = Array.from(dayMap.entries()).map(([key,val])=>({
				key,
				avg: val.cnt ? val.sum/val.cnt : null,
				ts: val.ts
			}));
			// ensure chronological order as in series
			days.sort((a,b)=>a.key.localeCompare(b.key));
			grid.style.gridTemplateColumns = `repeat(${days.length},20px)`;
			days.forEach((dy,idx)=>{
				const div = document.createElement('div');
				div.className = 'cell ' + classForRatio(dy.avg);
				div.dataset.kind = 'day';
				div.dataset.ts = String(Math.floor(dy.ts/1000));
				div.dataset.ok = dy.avg==null ? '' : String(dy.avg);
				div.dataset.server = name;
				div.style.opacity = '0';
				div.style.transform = 'scale(0.8) translateY(10px)';
				div.addEventListener('mouseenter', onCellEnter);
				div.addEventListener('mousemove', onCellMove);
				div.addEventListener('mouseleave', onCellLeave);
				grid.appendChild(div);
				setTimeout(()=>{
					div.style.transition = 'all 0.4s cubic-bezier(0.4,0,0.2,1)';
					div.style.opacity = '1';
					div.style.transform = 'scale(1) translateY(0)';
				}, idx * 20);
			});
			node.querySelector('[data-hours]').remove();
			const first = days[0];
			const last = days[days.length-1];
			node.querySelector('[data-start]').textContent = fmtDateOnly.format(new Date(first.ts)) + ' МСК';
			node.querySelector('[data-end]').textContent = fmtDateOnly.format(new Date(last.ts)) + ' МСК';
		}

		list.appendChild(node);
	});
}

function onCellEnter(e){
	const el = e.currentTarget;
	const ts = Number(el.dataset.ts);
	const okRatio = el.dataset.ok === '' ? null : Number(el.dataset.ok);
	const server = el.dataset.server;
	const kind = el.dataset.kind;
	let title = '';
	if(kind==='day'){
		const dateStr = fmtDateOnly.format(new Date(ts*1000)) + ' МСК';
		title = `${dateStr}`;
	} else {
		title = ts ? hourRangeShifted(ts) : '—';
	}
	const status = okRatio==null ? 'нет данных' : `${Math.round(okRatio*100)}% успешных проверок`;
	tooltip.innerHTML = `<div><strong>${server}</strong></div><div class=\"muted\">${title}</div><div>${status}</div>`;
	tooltip.classList.add('show');
	positionTooltip(e);
}

function onCellMove(e){
	positionTooltip(e);
}

function onCellLeave(){
	tooltip.classList.remove('show');
}

function positionTooltip(e){
	const pad = 14;
	let x = e.clientX + pad;
	let y = e.clientY - pad;
	const rect = tooltip.getBoundingClientRect();
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	if(x + rect.width + 20 > vw) x = e.clientX - rect.width - pad;
	if(y - rect.height - 20 < 0) y = e.clientY + pad;
	tooltip.style.left = x + 'px';
	tooltip.style.top = y + 'px';
}

function chunk(arr, size){
	const out = [];
	for(let i=0;i<arr.length;i+=size){
		out.push(arr.slice(i, i+size));
	}
	return out;
}

async function main(){
	document.querySelectorAll('.btn').forEach(b=>{
		b.addEventListener('click', async ()=>{
			const p = b.dataset.period;
			if(p===state.period) return;
			b.style.transform = 'scale(0.95)';
			setTimeout(async ()=>{
				state.period = p;
				setActive(p);
				await loadData();
				render();
				b.style.transform = 'scale(1)';
			}, 100);
		});
	});
	setActive(state.period);
	try { await fetch('/api/force-check', { method: 'POST' }); } catch {}
	await loadData();
	render();
	setInterval(async ()=>{ await loadData(); render(); }, 60000);
}

main();
