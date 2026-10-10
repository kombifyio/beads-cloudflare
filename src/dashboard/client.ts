/** Browser code remains a separate same-origin resource under the dashboard CSP. */
export const dashboardScript = String.raw`
(() => {
  'use strict';
  const copy = {
    de: { resetFilters:'Filter zurücksetzen',minimum:'Min.',maximum:'Max.',fromDate:'Ab Datum',throughDate:'Bis Datum',sortAscending:'Aufsteigend sortieren',sortDescending:'Absteigend sortieren',filterHint:'Suche nach Name, Tracker oder Alias. Zahlen und Datum lassen sich unten eingrenzen.',matchingRepos:'Repositories angezeigt', areas:'Bereiche',areasHint:'Klick auf einen Bereich filtert Repositories und Scopes.',allAreas:'Gesamtes Ökosystem',repoCount:'Repositories',scopes:'Scopes',labels:'Labels',types:'Typen',searchScopes:'Scope suchen …',scopeNote:'Scopes sind Labels oder Aufgabentypen über alle Repositories. Eine Aufgabe kann mehrere Labels tragen.',scope:'Scope',noScopes:'Keine Scopes für diese Auswahl.',modules:'Module',modulesHint:'Epics mit dem Fortschritt ihrer Unteraufgaben.',repoScopes:'Scopes in diesem Repository',noModules:'Keine Epics in diesem Repository.',unfiled:'Ohne Modul',truncated:'Sehr großer Tracker: nicht alle Aufgaben wurden ausgewertet.',scopesPartial:'Nicht lesbar:',inRepos:'in',subtasks:'Unteraufgaben',refresh:'Aktualisieren',logout:'Abmelden',signedIn:'Angemeldet als',eyebrow:'Cloudflare · Beads',title:'Arbeit im Überblick.',intro:'Aktuelle Aufgaben und ihr Verlauf, direkt aus der gemeinsamen Beads-Datenquelle.',history:'Aufgabenverlauf',historySource:'Datenquelle',archive:'Dolt-Archiv',archiveNote:'Dolt-Archiv · ursprünglich erfasste Tage (Europe/Berlin). Historische Repository-Abdeckung kann variieren.',days:' Tage',table:'Tabelle',ratio:'Fortschritt = abgeschlossene Aufgaben ÷ alle Aufgaben. Dies misst Aufgabenabschluss, keine Produktreife.',repositories:'Repositories',searchRepos:'Repository suchen …',sortName:'Name',sortActive:'Aktive Aufgaben',sortBlocked:'Blockierte Aufgaben',sortCompletion:'Fortschritt',footer:'Cloudflare ist die operative Beads-Datenquelle.',readonly:'Lesender Zugriff · keine Aufgabenänderungen',close:'Schließen',searchTasks:'Aufgaben suchen …',more:'Weitere laden',total:'Alle Aufgaben',open:'Offen',in_progress:'In Arbeit',blocked:'Blockiert',closed:'Abgeschlossen',deferred:'Zurückgestellt',active:'Aktiv',completion:'Fortschritt',all:'Alle',allGroups:'Alle Gruppen',loading:'Daten werden geladen …',failed:'Daten konnten nicht geladen werden. Bitte erneut versuchen.',login:'Anmelden',unauthorized:'Bitte anmelden, um die privaten Beads-Daten zu sehen.',partial:'Einige Repositories konnten nicht gelesen werden. Die angezeigten Summen sind unvollständig.',stale:'Dieser Datenstand ist älter als 15 Minuten.',updated:'Stand',noRepos:'Keine Repositories für diese Auswahl.',noTasks:'Keine Aufgaben für diese Auswahl.',noHistory:'Noch keine historischen Beobachtungen. Der Verlauf wächst mit den täglichen Erfassungen.',date:'Datum',tasks:'Aufgaben',owner:'Zuständig',priority:'Priorität',type:'Typ',description:'Beschreibung',comments:'Kommentare',dependencies:'Abhängigkeiten',none:'Keine Angaben',unavailable:'Nicht verfügbar',readError:'Lesefehler',shared:'Gemeinsamer Tracker',loaded:'Aufgaben geladen',noPageTasks:'Keine Treffer auf dieser Seite. Weitere Seiten sind verfügbar.',current:'Aktueller Stand',utcDays:'Tagesstände nach UTC.',range:'Tagesverlauf',unassigned:'Unzugewiesen',ready:'Bereit',chartLabel:'Verlauf abgeschlossener und aller Aufgaben',closedLegend:'Abgeschlossen',totalLegend:'Alle Aufgaben' },
    en: { resetFilters:'Reset filters',minimum:'Min.',maximum:'Max.',fromDate:'From date',throughDate:'Through date',sortAscending:'Sort ascending',sortDescending:'Sort descending',filterHint:'Search by name, tracker or alias. Narrow numbers and dates below.',matchingRepos:'repositories shown', areas:'Areas',areasHint:'Click an area to filter repositories and scopes.',allAreas:'Whole ecosystem',repoCount:'Repositories',scopes:'Scopes',labels:'Labels',types:'Types',searchScopes:'Search scopes …',scopeNote:'Scopes are labels or task types across all repositories. A task can carry several labels.',scope:'Scope',noScopes:'No scopes match this selection.',modules:'Modules',modulesHint:'Epics with the progress of their subtasks.',repoScopes:'Scopes in this repository',noModules:'No epics in this repository.',unfiled:'No module',truncated:'Very large tracker: not every task was evaluated.',scopesPartial:'Unreadable:',inRepos:'in',subtasks:'subtasks',refresh:'Refresh',logout:'Sign out',signedIn:'Signed in as',eyebrow:'Cloudflare · Beads',title:'Work at a glance.',intro:'Current tasks and their history, directly from the shared Beads data source.',history:'Task history',historySource:'Data source',archive:'Dolt archive',archiveNote:'Dolt archive · originally recorded days (Europe/Berlin). Historical repository coverage varies.',days:' days',table:'Table',ratio:'Progress = closed tasks ÷ all tasks. This measures task closure, not product readiness.',repositories:'Repositories',searchRepos:'Search repositories …',sortName:'Name',sortActive:'Active tasks',sortBlocked:'Blocked tasks',sortCompletion:'Progress',footer:'Cloudflare is the operational Beads data source.',readonly:'Read-only access · no task changes',close:'Close',searchTasks:'Search tasks …',more:'Load more',total:'All tasks',open:'Open',in_progress:'In progress',blocked:'Blocked',closed:'Closed',deferred:'Deferred',active:'Active',completion:'Progress',all:'All',allGroups:'All groups',loading:'Loading data …',failed:'Could not load data. Please try again.',login:'Sign in',unauthorized:'Sign in to view private Beads data.',partial:'Some repositories could not be read. Displayed totals are incomplete.',stale:'This snapshot is more than 15 minutes old.',updated:'Updated',noRepos:'No repositories match this selection.',noTasks:'No tasks match this selection.',noHistory:'No historical observations yet. History grows with daily captures.',date:'Date',tasks:'Tasks',owner:'Assignee',priority:'Priority',type:'Type',description:'Description',comments:'Comments',dependencies:'Dependencies',none:'No information',unavailable:'Unavailable',readError:'Read error',shared:'Shared tracker',loaded:'tasks loaded',noPageTasks:'No matches on this page. More pages are available.',current:'Current observation',utcDays:'Daily observations in UTC.',range:'Daily history',unassigned:'Unassigned',ready:'Ready',chartLabel:'History of closed and all tasks',closedLegend:'Closed',totalLegend:'All tasks' }
  };
  let language = (navigator.language || 'de').startsWith('en') ? 'en' : 'de';
  const groupNames = { de: { integration:'Plattform & Integration', ai:'AI-Plattform', saas:'SaaS', techstack:'Techstack & Runtime', stackkits:'StackKits', 'companion-voice':'Companion & Voice' }, en: { integration:'Platform & integration', ai:'AI platform', saas:'SaaS', techstack:'Techstack & runtime', stackkits:'StackKits', 'companion-voice':'Companion & voice' } };
  const groupName = (g) => (groupNames[language] || {})[g] || g;
  let scopeData, scopeRequest = 0, moduleRequest = 0;
  let authenticated = false, snapshot, days = 30, historySource = 'cloudflare', selectedRepo, taskPage, taskRequest = 0, issueRequest = 0, overviewRequest = 0, searchTimer;
  let repositorySort = {key:'name',direction:1};
  let repositoryFilters = {};
  const repositoryColumns = ['name','total','active','in_progress','blocked','completion','updated'];
  const repositoryLabel = (key) => key==='name' ? 'repositories' : key;
  const $ = (id) => document.getElementById(id);
  const t = (key) => copy[language][key] || key;
  const num = (n) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(language) : '—';
  const date = (value) => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; };
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const clear = (node) => node.replaceChildren();
  function message(node, key) { clear(node); node.append(el('p',t(key),'empty')); }
  function error(node, err) { if(err.status===401){authenticated=false;$('viewer').textContent='';$('viewer').hidden=true;$('logout-form').hidden=true;} clear(node); node.append(el('p',t(err.status === 401 ? 'unauthorized' : 'failed'),'empty')); if (err.status === 401) { const a = el('a',t('login')); a.href='/dashboard/login'; node.append(a); } }
  async function get(url) { const response = await fetch(url,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(25000)}); if (!response.ok) { const err=new Error('request failed'); err.status=response.status; throw err; } return response.json(); }
  function localize() {
    document.documentElement.lang=language; document.querySelectorAll('[data-i18n]').forEach(n => n.textContent=t(n.dataset.i18n));
    document.querySelectorAll('[data-placeholder]').forEach(n => { n.placeholder=t(n.dataset.placeholder); n.setAttribute('aria-label',n.placeholder); });
    $('language').textContent=language === 'de' ? 'EN' : 'DE'; $('group').setAttribute('aria-label',t('allGroups')); $('task-status').setAttribute('aria-label',t('tasks'));
    const status=$('task-status').value || 'all'; clear($('task-status')); ['all','open','in_progress','blocked','deferred','closed'].forEach(s => { const o=el('option',t(s)); o.value=s; $('task-status').append(o); }); $('task-status').value=status;
    $('history-source').setAttribute('aria-label',t('historySource')); if (snapshot) render(); if (taskPage) renderTasks(); if(selectedRepo) renderRepoHistory();
  }
  function notice() {
    clear($('notice')); const notes=[];
    if (snapshot.source && snapshot.source.partial) notes.push(t('partial'));
    const age=Date.now()-Date.parse(snapshot.generatedAt); if (!Number.isFinite(age) || age>15*60000) notes.push(t('stale'));
    $('notice').classList.toggle('error',notes.length>0); $('notice').textContent=notes.join(' ');
  }
  function render() {
    notice(); $('logout-form').hidden=!authenticated; $('viewer').hidden=!authenticated || !snapshot.viewer?.email; $('viewer').textContent=authenticated && snapshot.viewer?.email ? t('signedIn')+' '+snapshot.viewer.email : ''; $('dashboard-name').textContent=snapshot.title || 'Beads / Portfolio'; $('freshness').textContent=t('updated')+' · '+date(snapshot.generatedAt);
    clear($('kpis')); ['total','open','in_progress','blocked','closed','completion'].forEach(key => {
      const card=el('div',undefined,'kpi'+(key==='blocked' ? ' danger' : '')); card.append(el('span',t(key)));
      const c=snapshot.totals || {}; const value=key==='completion' ? (c.total ? Math.round(100*c.closed/c.total) : 0)+'%' : num(c[key]); card.append(el('strong',value)); $('kpis').append(card);
    });
    const selected=$('group').value; clear($('group')); const all=el('option',t('allGroups')); all.value=''; $('group').append(all);
    [...new Set((snapshot.repositories || []).map(r=>r.group).filter(Boolean))].sort().forEach(g=>{ const o=el('option',groupName(g)); o.value=g; $('group').append(o); }); $('group').value=selected;
    renderHistorySources(); renderAreas(); renderRepositories(); renderScopes(); renderHistory(); if(selectedRepo) renderRepoHistory();
  }

  function bar(pct) { const wrap=el('div',undefined,'progress'), b=el('span',undefined,'bar'), fill=el('i'); const v=Math.max(0,Math.min(100,Number(pct)||0)); fill.style.width=v+'%'; b.append(fill); wrap.append(b,el('span',num(v)+'%')); return wrap; }
  function renderAreas() {
    const root=$('areas'); clear(root);
    const selected=$('group').value, repos=(snapshot.repositories || []).filter(r=>!r.error);
    const areas=[['',repos]].concat([...new Set(repos.map(r=>r.group).filter(Boolean))].sort((a,b)=>groupName(a).localeCompare(groupName(b),language)).map(g=>[g,repos.filter(r=>r.group===g)]));
    areas.forEach(([g,list])=>{
      const c={total:0,closed:0,active:0,blocked:0,in_progress:0}; list.forEach(r=>Object.keys(c).forEach(k=>c[k]+=Number(r.counts[k])||0));
      const button=el('button',undefined,'area'); button.setAttribute('aria-pressed',String(g===selected));
      button.append(el('strong',g ? groupName(g) : t('allAreas')),el('span',num(list.length)+' '+t('repoCount')+' · '+num(c.active)+' '+t('active'),'sub'),el('span',num(c.in_progress)+' '+t('in_progress')+' · '+num(c.blocked)+' '+t('blocked'),'sub'+(c.blocked ? ' danger-text' : '')),bar(c.total ? Math.round(100*c.closed/c.total) : 0));
      button.addEventListener('click',()=>{ $('group').value=g; renderAreas(); renderRepositories(); renderScopes(); });
      root.append(button);
    });
  }
  async function loadScopes() { const request=++scopeRequest; message($('scopes'),'loading'); try { const data=await get('/dashboard/api/scopes'); if(request!==scopeRequest)return; scopeData=data; renderScopes(); } catch(err) { if(request===scopeRequest) error($('scopes'),err); } }
  function renderScopes() {
    if(!scopeData) return; const root=$('scopes'); clear(root);
    const group=$('group').value, query=$('scope-search').value.toLocaleLowerCase(), kind=$('scope-kind').value;
    const ids=new Set((snapshot.repositories || []).filter(r=>!group || r.group===group).map(r=>r.id));
    const names=new Map((snapshot.repositories || []).map(r=>[r.id,r.name]));
    const rows=(scopeData[kind] || []).map(s=>{ const repos=Object.entries(s.repositories || {}).filter(([id])=>ids.has(id)); return {key:s.key,repos,total:repos.reduce((n,[,v])=>n+v.total,0),closed:repos.reduce((n,[,v])=>n+v.closed,0)}; }).filter(s=>s.total && s.key.toLocaleLowerCase().includes(query)).sort((a,b)=>b.total-a.total || a.key.localeCompare(b.key)).slice(0,60);
    if((scopeData.unavailable || []).length) root.append(el('p',t('scopesPartial')+' '+scopeData.unavailable.map(id=>names.get(id) || id).join(', '),'notice error'));
    if(!rows.length) return root.append(el('p',t('noScopes'),'empty'));
    const {table:tbl,body}=table(['scope','total','active','closed','completion','repositories']);
    rows.forEach(s=>{ const row=el('tr'); row.append(el('td',s.key),el('td',num(s.total)),el('td',num(s.total-s.closed)),el('td',num(s.closed))); const p=el('td'); p.append(bar(s.total ? Math.round(100*s.closed/s.total) : 0)); row.append(p,el('td',s.repos.sort((a,b)=>b[1].total-a[1].total).map(([id,v])=>(names.get(id) || id)+' ('+num(v.total)+')').join(', '),'scope-repos')); body.append(row); });
    root.append(tbl);
  }
  async function loadModules(repo) { const request=++moduleRequest; message($('modules'),'loading'); clear($('repo-scopes')); try { const data=await get('/dashboard/api/repositories/'+encodeURIComponent(repo.id)+'/modules'); if(request!==moduleRequest || selectedRepo!==repo)return; renderModules(data); } catch(err) { if(request===moduleRequest) error($('modules'),err); } }
  function renderModules(data) {
    const root=$('modules'); clear(root);
    if(data.truncated) root.append(el('p',t('truncated'),'notice error'));
    const children=new Map(); (data.modules || []).forEach(m=>{ const k=m.parent || ''; (children.get(k) || children.set(k,[]).get(k)).push(m); });
    const draw=(m,depth)=>{ const item=el('div',undefined,'module'+(depth ? ' nested' : '')); item.style.marginLeft=(Math.min(depth,4)*18)+'px'; const head=el('div',undefined,'module-head'), title=el('button',m.title,'module-title'); title.addEventListener('click',()=>openIssue({id:m.id,title:m.title})); head.append(title,el('span',t(m.status),'badge '+m.status)); item.append(head,el('span',m.id+' · P'+m.priority+' · '+num(m.counts.total)+' '+t('subtasks')+' · '+num(m.counts.active)+' '+t('active')+(m.counts.blocked ? ' · '+num(m.counts.blocked)+' '+t('blocked') : '')+(m.assignee ? ' · '+m.assignee : ''),'sub'),bar(m.counts.completion)); root.append(item); (children.get(m.id) || []).forEach(c=>draw(c,depth+1)); };
    (children.get('') || []).forEach(m=>draw(m,0));
    if(!(data.modules || []).length) root.append(el('p',t('noModules'),'empty'));
    if(data.unfiled && data.unfiled.total) { const item=el('div',undefined,'module'); item.append(el('strong',t('unfiled')),el('span',num(data.unfiled.total)+' '+t('tasks')+' · '+num(data.unfiled.active)+' '+t('active'),'sub'),bar(data.unfiled.completion)); root.append(item); }
    const chips=$('repo-scopes'); clear(chips);
    (data.scopes || []).slice(0,40).forEach(s=>{ const chip=el('span',s.key+' · '+num(s.counts.closed)+'/'+num(s.counts.total),'badge'); chip.title=t('completion')+' '+s.counts.completion+'%'; chips.append(chip); });
    if(!(data.scopes || []).length) chips.append(el('span',t('none'),'sub'));
  }
  function table(headers) { const table=el('table'),thead=el('thead'),tr=el('tr'); headers.forEach(h=>{const th=el('th',t(h)); th.scope='col'; tr.append(th);}); thead.append(tr); table.append(thead); const body=el('tbody'); table.append(body); return {table,body}; }
  function repositoryValue(repo,key) {
    if(key==='name') return repo.name;
    if(key==='updated') { const time=Date.parse(repo.updatedAt); return Number.isFinite(time) ? time : null; }
    if(repo.error) return null;
    const value=key==='completion' ? repo.completion : repo.counts[key];
    return value!==null && value!==undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  }
  function renderRepositories() {
    clear($('repositories'));
    const {table:tbl}=table([]), head=tbl.tHead, titles=head.rows[0], filters=el('tr',undefined,'column-filters');
    tbl.className='repository-table';
    repositoryColumns.forEach(key=>{
      const th=el('th'), button=el('button',undefined,'column-sort'); th.scope='col'; th.dataset.column=key;
      button.append(el('span',t(repositoryLabel(key))),el('span',undefined,'sort-indicator'));
      button.lastChild.setAttribute('aria-hidden','true');
      button.addEventListener('click',()=>{
        repositorySort={key,direction:repositorySort.key===key ? -repositorySort.direction : key==='name' ? 1 : -1};
        renderRepositoryRows();
      }); th.append(button); titles.append(th);
      const cell=el('td');
      if(key==='name') cell.append(el('span',t('filterHint'),'filter-hint'));
      else {
        const isDate=key==='updated', range=repositoryFilters[key] || {};
        ['min','max'].forEach(bound=>{
          const label=el('label',t(isDate ? bound==='min' ? 'fromDate' : 'throughDate' : bound==='min' ? 'minimum' : 'maximum'));
          const input=el('input'); input.type=isDate ? 'date' : 'number'; input.value=range[bound] || '';
          input.id='filter-'+key+'-'+bound;
          input.setAttribute('aria-label',t(repositoryLabel(key))+' · '+label.textContent);
          if(!isDate) { input.min='0'; input.step='1'; if(key==='completion') input.max='100'; }
          input.addEventListener('input',()=>{
            repositoryFilters[key]={...repositoryFilters[key],[bound]:input.value}; renderRepositoryRows();
          }); label.append(input); cell.append(label);
        });
      }
      filters.append(cell);
    });
    head.append(filters); $('repositories').append(tbl); renderRepositoryRows();
  }
  function renderRepositoryRows() {
    const query=$('repo-search').value.trim().toLocaleLowerCase(language), group=$('group').value;
    const all=snapshot.repositories || [];
    const repos=all.filter(repo=>{
      if(group && repo.group!==group) return false;
      if(!(repo.name+' '+repo.id+' '+repo.tracker+' '+(repo.aliases || []).map(a=>typeof a==='string' ? a : a.name || a.id).join(' ')).toLocaleLowerCase(language).includes(query)) return false;
      return Object.entries(repositoryFilters).every(([key,range])=>{
        const value=repositoryValue(repo,key);
        return ['min','max'].every(bound=>{
          if(!range[bound]) return true;
          if(value===null) return false;
          if(key==='updated') {
            // Date inputs describe whole days in the same local timezone as the displayed timestamps.
            const day=new Date(value), localDay=[day.getFullYear(),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0')].join('-');
            return bound==='min' ? localDay>=range[bound] : localDay<=range[bound];
          }
          return bound==='min' ? value>=Number(range[bound]) : value<=Number(range[bound]);
        });
      });
    }).sort((a,b)=>{
      const av=repositoryValue(a,repositorySort.key), bv=repositoryValue(b,repositorySort.key);
      // Unavailable metrics stay last in either direction, rather than masquerading as zero.
      if(av===null || bv===null) return av===bv ? a.name.localeCompare(b.name,language) : av===null ? 1 : -1;
      const order=typeof av==='string' ? av.localeCompare(bv,language) : av-bv;
      return order*repositorySort.direction || a.name.localeCompare(b.name,language);
    });
    const tbl=$('repositories').querySelector('table'), body=tbl.tBodies[0]; clear(body);
    tbl.querySelectorAll('th[data-column]').forEach(th=>{
      const active=repositorySort.key===th.dataset.column, ascending=active && repositorySort.direction===1;
      th.setAttribute('aria-sort',active ? ascending ? 'ascending' : 'descending' : 'none');
      th.querySelector('.sort-indicator').textContent=active ? ascending ? '↑' : '↓' : '↕';
      th.firstChild.setAttribute('aria-label',t(repositoryLabel(th.dataset.column))+' · '+t(ascending || !active && th.dataset.column!=='name' ? 'sortDescending' : 'sortAscending'));
    });
    $('repo-results').textContent=num(repos.length)+' / '+num(all.length)+' '+t('matchingRepos');
    if(!repos.length) { const row=el('tr'), cell=el('td',t('noRepos'),'empty'); cell.colSpan=repositoryColumns.length; row.append(cell); body.append(row); return; }
    repos.forEach(repo=>{ const row=el('tr'),name=el('td'),button=el('button',repo.name,'repo-name'); button.addEventListener('click',()=>openRepo(repo)); name.append(button,el('span',(repo.group ? groupName(repo.group)+' · ' : '')+repo.tracker,'sub')); if((repo.aliases || []).length) name.append(el('span',t('shared')+' · '+repo.aliases.map(a=>typeof a==='string' ? a : a.name || a.id).join(', '),'sub')); if(repo.error) name.append(el('span',t('readError'),'sub danger-text')); row.append(name);
      ['total','active','in_progress','blocked'].forEach(k=>row.append(el('td',repo.error ? '—' : num(repo.counts[k]),k==='blocked' && repo.counts[k] ? 'danger-text' : '')));
      const progress=el('td'),wrap=el('div',undefined,'progress'); const pct=Math.max(0,Math.min(100,Number(repo.completion)||0)); const bar=el('span',undefined,'bar'),fill=el('i'); fill.style.width=pct+'%'; bar.append(fill); wrap.append(bar,el('span',repo.error ? '—' : num(pct)+'%')); progress.append(wrap); row.append(progress,el('td',date(repo.updatedAt))); body.append(row); });
  }
  function renderHistorySources() {
    clear($('history-source')); const live=el('option','Cloudflare');live.value='cloudflare';$('history-source').append(live);
    if(snapshot.archive && snapshot.archive.points.length) {const archive=el('option',t('archive'));archive.value='dolt';$('history-source').append(archive);}
    else historySource='cloudflare';
    $('history-source').value=historySource;
    const note=$('repository-history').querySelector('[data-i18n="utcDays"]');note.textContent=historySource==='dolt' ? t('archiveNote') : t('utcDays');
  }
  function historyPoints() {
    const points=(historySource==='dolt' ? snapshot.archive?.points || [] : snapshot.history || []).slice();
    const observed=new Date(snapshot.generatedAt);
    if(historySource==='cloudflare' && Number.isFinite(observed.getTime())) {
      const today=observed.toISOString().slice(0,10);
      if(!points.some(p=>p.date===today)) points.push({date:today,generatedAt:snapshot.generatedAt,totals:snapshot.totals,repositories:snapshot.repositories,current:true});
    }
    return points.sort((a,b)=>a.date.localeCompare(b.date));
  }
  function renderRepoHistory() {
    const root=$('repository-history-table'); clear(root);
    const {table:tbl,body}=table(['date','total','open','in_progress','blocked','closed']);
    const observations=historyPoints();
    const currentDate=new Date(snapshot.generatedAt);
    if(historySource==='cloudflare' && !observations.some(p=>p.current) && Number.isFinite(currentDate.getTime())) observations.push({date:currentDate.toISOString().slice(0,10),generatedAt:snapshot.generatedAt,repositories:snapshot.repositories,current:true});
    const points=observations.map(p=>({point:p,repo:(p.repositories || []).find(r=>r.id===selectedRepo.id)})).filter(p=>p.repo);
    points.reverse().slice(0,90).forEach(({point,repo})=>{const row=el('tr');row.append(el('td',point.date+(historySource==='dolt' ? ' · Europe/Berlin' : ' · UTC')+(point.current ? ' · '+t('current') : '')));['total','open','in_progress','blocked','closed'].forEach(k=>row.append(el('td',num(repo.counts[k]))));body.append(row);});
    if(!points.length) message(root,'noHistory'); else root.append(tbl);
  }
  function renderHistory() {
    const allPoints=historyPoints(); const last=allPoints[allPoints.length-1]; const reference=historySource==='dolt' && last ? Date.parse(last.generatedAt || last.date) : Date.now(); const cutoff=reference-days*86400000; const points=allPoints.filter(p=>Date.parse(p.generatedAt || p.date)>=cutoff).slice().sort((a,b)=>a.date.localeCompare(b.date));
    clear($('chart')); clear($('history-table')); if(!points.length){ message($('chart'),'noHistory'); return; }
    const {table:tbl,body}=table(['date','total','closed','completion']); points.forEach(p=>{const c=p.totals || {}, row=el('tr'); [p.date+(historySource==='dolt' ? ' · Europe/Berlin' : ' · UTC')+(p.current ? ' · '+t('current') : ''),num(c.total),num(c.closed),(c.total ? Math.round(c.closed/c.total*100) : 0)+'%'].forEach(v=>row.append(el('td',v))); body.append(row);}); $('history-table').append(tbl);
    const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg'); svg.setAttribute('viewBox','0 0 1000 190'); svg.setAttribute('role','img'); svg.setAttribute('aria-label',t('chartLabel')); svg.classList.add('chart');
    const make=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,String(v)));if(text!==undefined)n.textContent=text;svg.append(n);return n;};
    const max=Math.max(1,...points.map(p=>Number(p.totals.total)||0)); const x=i=>48+i*(910/Math.max(1,points.length-1)), y=n=>150-Number(n || 0)/max*120;
    [0,.5,1].forEach(f=>{const yy=y(max*f);make('line',{x1:48,x2:958,y1:yy,y2:yy,stroke:'#dfe6df'});make('text',{x:0,y:yy+4},num(Math.round(max*f)));});
    ['total','closed'].forEach((key,k)=>{const color=k?'#14675a':'#829a91';make('polyline',{points:points.map((p,i)=>x(i)+','+y(p.totals[key])).join(' '),fill:'none',stroke:color,'stroke-width':k?3:2});if(points.length===1)make('circle',{cx:x(0),cy:y(points[0].totals[key]),r:4,fill:color});});
    make('text',{x:48,y:181},points[0].date);make('text',{x:958,y:181,'text-anchor':'end'},points[points.length-1].date); $('chart').append(svg);
    $('chart').append(el('p',t('totalLegend')+' — '+t('closedLegend')+' · '+(historySource==='dolt' ? t('archiveNote') : t('utcDays'))+(points.some(p=>p.current) ? ' · '+t('current') : ''),'chart-note'));
  }
  async function refresh() { const request=++overviewRequest; $('refresh').disabled=true; $('refresh').textContent=t('loading'); if(!snapshot) $('notice').textContent=t('loading'); try {const data=await get('/dashboard/api/overview'); if(request!==overviewRequest)return; authenticated=true; snapshot=data; render(); loadScopes();} catch(err) {if(request===overviewRequest) { $('notice').classList.add('error'); error($('notice'),err); }} finally {if(request===overviewRequest){$('refresh').disabled=false;$('refresh').textContent=t('refresh');}} }
  function openRepo(repo) {selectedRepo=repo;renderRepoHistory();taskPage=undefined;$('repository-title').textContent=repo.name;$('task-search').value='';$('task-status').value='all';$('repository-dialog').showModal();loadModules(repo);loadTasks();}
  async function loadTasks(more=false) { const request=++taskRequest; const repo=selectedRepo; if(!repo)return; $('more-tasks').disabled=true; if(!more)message($('tasks'),'loading'); const params=new URLSearchParams({status:$('task-status').value,q:$('task-search').value}); if(more && taskPage && taskPage.nextCursor)params.set('cursor',taskPage.nextCursor);
    try{ const data=await get('/dashboard/api/repositories/'+encodeURIComponent(repo.id)+'/issues?'+params); if(request!==taskRequest || selectedRepo!==repo)return;taskPage={...data,items:more ? [...taskPage.items,...data.items] : data.items};renderTasks();}catch(err){if(request===taskRequest){error($('tasks'),err);$('more-tasks').hidden=true;}}finally{if(request===taskRequest)$('more-tasks').disabled=false;}
  }
  function renderTasks() { clear($('tasks')); $('task-summary').textContent=num(taskPage.items.length)+' '+t('loaded'); if(!taskPage.items.length)message($('tasks'),taskPage.nextCursor ? 'noPageTasks' : 'noTasks');taskPage.items.forEach(issue=>{const button=el('button',undefined,'task');button.append(el('span',issue.title,'task-title'));const meta=el('span',undefined,'task-meta');meta.append(el('span',issue.id),el('span',t(issue.status),'badge '+issue.status),el('span','P'+issue.priority),el('span',issue.assignee || t('unassigned')),el('span',date(issue.updated_at)));button.append(meta);button.addEventListener('click',()=>openIssue(issue));$('tasks').append(button);});$('more-tasks').hidden=!taskPage.nextCursor; }
  async function openIssue(issue) {const request=++issueRequest;$('issue-title').textContent=issue.title;message($('issue-detail'),'loading');$('issue-dialog').showModal();try{const data=await get('/dashboard/api/repositories/'+encodeURIComponent(selectedRepo.id)+'/issues/'+encodeURIComponent(issue.id));if(request!==issueRequest)return;renderIssue(data.issue || data);}catch(err){if(request===issueRequest)error($('issue-detail'),err);}}
  function renderIssue(issue) {const root=$('issue-detail');clear(root);const grid=el('div',undefined,'detail-grid');[['tasks',issue.id],['priority','P'+issue.priority],['owner',issue.assignee || issue.owner],['type',issue.issue_type],['updated',date(issue.updated_at)],['all',t(issue.status)]].forEach(([key,value])=>{const item=el('div',t(key));item.append(el('strong',value || t('none')));grid.append(item);});root.append(grid);const labels=el('div',undefined,'detail-labels');(issue.labels || []).forEach(l=>labels.append(el('span',l,'badge')));root.append(labels,el('h3',t('description')),el('p',issue.description || t('none'),'detail-description')); const deps=issue.dependencies || [];root.append(el('h3',t('dependencies')));if(Array.isArray(deps) && deps.length){const ul=el('ul');deps.forEach(d=>ul.append(el('li',typeof d==='string' ? d : (d.depends_on_id || d.id || '')+' · '+(d.dependency_type || d.type || ''))));root.append(ul);}else root.append(el('p',t('none')));root.append(el('h3',t('comments')));(issue.comments || []).forEach(c=>{const article=el('article',undefined,'comment');article.append(el('strong',c.author || t('none')),el('span',date(c.created_at),'sub'),el('p',c.text || c.body || ''));root.append(article);});if(!(issue.comments || []).length)root.append(el('p',t('none')));}
  $('language').addEventListener('click',()=>{language=language==='de'?'en':'de';localize();}); $('refresh').addEventListener('click',refresh);
  ['repo-search','group'].forEach(id=>$(id).addEventListener(id==='repo-search'?'input':'change',()=>{if(snapshot){renderRepositories();if(id==='group'){renderAreas();renderScopes();}}}));
  $('reset-repository-filters').addEventListener('click',()=>{repositoryFilters={};$('repo-search').value='';$('group').value='';if(snapshot){renderRepositories();renderAreas();renderScopes();}});
  ['scope-search','scope-kind'].forEach(id=>$(id).addEventListener(id==='scope-search'?'input':'change',()=>{if(snapshot)renderScopes();}));
  document.querySelectorAll('.range').forEach(button=>button.addEventListener('click',()=>{days=Number(button.dataset.days);document.querySelectorAll('.range').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(snapshot)renderHistory();}));
  $('history-source').addEventListener('change',()=>{historySource=$('history-source').value;renderHistorySources();renderHistory();if(selectedRepo)renderRepoHistory();});
  $('table-toggle').addEventListener('click',()=>{const show=$('history-table').hidden;$('history-table').hidden=!show;$('chart').hidden=show;$('table-toggle').setAttribute('aria-pressed',String(show));});
  $('close-repository').addEventListener('click',()=>$('repository-dialog').close());$('close-issue').addEventListener('click',()=>$('issue-dialog').close());
  $('repository-dialog').addEventListener('close',()=>{++taskRequest;++moduleRequest;selectedRepo=undefined;});$('issue-dialog').addEventListener('close',()=>++issueRequest);
  $('task-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadTasks(),300);});$('task-status').addEventListener('change',()=>loadTasks());$('more-tasks').addEventListener('click',()=>loadTasks(true));
  localize(); refresh();
})();
`;
