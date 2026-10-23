/** Browser code remains a separate same-origin resource under the dashboard CSP. */
export const dashboardScript = String.raw`
(() => {
  'use strict';
  const copy = {
    de: { roadmaps:'Roadmaps',roadmapHint:'ROADMAP.md jedes Repositories, live aus GitHub gelesen und mit den Beads je Meilenstein verknüpft.',fullText:'Volltext',milestoneView:'Meilensteine',onGithub:'Auf GitHub öffnen',lastChanged:'zuletzt geändert',verified:'geprüft',checklist:'Checkliste',beadsProgress:'Beads',openBeads:'Offene Beads',currentMilestone:'Aktuell',noRoadmap:'Dieses Repository hat keine ROADMAP.md.',noRoadmaps:'Keine Roadmaps freigegeben.',roadmapUnavailable:'Die Roadmap konnte nicht von GitHub gelesen werden. Bitte später erneut versuchen.',noRoadmapMilestones:'In dieser Roadmap wurden keine Meilensteine im Format vX.Y.Z gefunden.',epicMissing:'Epic fehlt in Beads',epic:'Epic',extraEpics:'Meilenstein-Epics nur in Beads',extraEpicsHint:'Diese Meilenstein-Epics stehen nicht in der ROADMAP.md.',noChecklist:'Keine Checkliste in diesem Meilenstein.',blocking:'blockierend',moreBeads:'weitere offene Beads',trackerUnavailable:'Beads konnten nicht gelesen werden; der Fortschritt zeigt nur die Checkliste.',uncoveredOpen:'offene Beads hängen an keinem Meilenstein.',markPulled:'↑ vorgezogen',markDeferred:'↓ verschoben',markAhead:'↑ vorab erledigt',fromVersion:'aus',toVersion:'nach',markPulledHint:'Aus einem späteren Meilenstein vorgezogen.',markDeferredHint:'In einen späteren Meilenstein verschoben.',markAheadHint:'Erledigt, bevor dieser Meilenstein an der Reihe ist.',showRoadmap:'Roadmap',state_done:'erledigt',state_current:'aktuell',state_planned:'geplant',state_deferred:'zurückgestellt',state_unknown:'ohne Status',milestones:'Meilensteine',milestonesHint:'Roadmap-Meilensteine je Repository, geordnet nach der zentralen Roadmap.',phase:'Phase',noMilestones:'Noch keine Meilensteine erfasst.',uncovered:'ohne Meilenstein',done:'erledigt',milestoneCount:'Meilensteine',allPhases:'Alle Phasen',resetFilters:'Filter zurücksetzen',statusFilter:'Aufgabenstatus',selectAll:'Alle auswählen',deselectAll:'Alle abwählen',noneSelected:'Keine',selected:'ausgewählt',statusFilterHint:'Repositories mit Aufgaben in mindestens einem ausgewählten Status.',sortAscending:'Aufsteigend sortieren',sortDescending:'Absteigend sortieren',matchingRepos:'Repositories angezeigt', areas:'Bereiche',areasHint:'Klick auf einen Bereich filtert Repositories und Scopes.',allAreas:'Gesamtes Ökosystem',repoCount:'Repositories',scopes:'Scopes',labels:'Labels',types:'Typen',searchScopes:'Scope suchen …',scopeNote:'Scopes sind Labels oder Aufgabentypen über alle Repositories. Eine Aufgabe kann mehrere Labels tragen.',scope:'Scope',noScopes:'Keine Scopes für diese Auswahl.',modules:'Module',modulesHint:'Epics mit dem Fortschritt ihrer Unteraufgaben.',repoScopes:'Scopes in diesem Repository',noModules:'Keine Epics in diesem Repository.',unfiled:'Ohne Modul',truncated:'Sehr großer Tracker: nicht alle Aufgaben wurden ausgewertet.',scopesPartial:'Nicht lesbar:',inRepos:'in',subtasks:'Unteraufgaben',refresh:'Aktualisieren',logout:'Abmelden',signedIn:'Angemeldet als',eyebrow:'Cloudflare · Beads',title:'Arbeit im Überblick.',intro:'Aktuelle Aufgaben und ihr Verlauf, direkt aus der gemeinsamen Beads-Datenquelle.',history:'Aufgabenverlauf',historySource:'Datenquelle',archive:'Dolt-Archiv',archiveNote:'Dolt-Archiv · ursprünglich erfasste Tage (Europe/Berlin). Historische Repository-Abdeckung kann variieren.',days:' Tage',table:'Tabelle',ratio:'Fortschritt = abgeschlossene Aufgaben ÷ alle Aufgaben. Dies misst Aufgabenabschluss, keine Produktreife.',repositories:'Repositories',searchRepos:'Repository suchen …',footer:'Cloudflare ist die operative Beads-Datenquelle.',readonly:'Lesender Zugriff · keine Aufgabenänderungen',close:'Schließen',searchTasks:'Aufgaben suchen …',more:'Weitere laden',total:'Alle Aufgaben',open:'Offen',in_progress:'In Arbeit',blocked:'Blockiert',closed:'Abgeschlossen',deferred:'Zurückgestellt',active:'Aktiv',completion:'Fortschritt',all:'Alle',allGroups:'Alle Gruppen',loading:'Daten werden geladen …',failed:'Daten konnten nicht geladen werden. Bitte erneut versuchen.',login:'Anmelden',unauthorized:'Bitte anmelden, um die privaten Beads-Daten zu sehen.',partial:'Einige Repositories konnten nicht gelesen werden. Die angezeigten Summen sind unvollständig.',stale:'Dieser Datenstand ist älter als 15 Minuten.',updated:'Stand',noRepos:'Keine Repositories für diese Auswahl.',noTasks:'Keine Aufgaben für diese Auswahl.',noHistory:'Noch keine historischen Beobachtungen. Der Verlauf wächst mit den täglichen Erfassungen.',date:'Datum',tasks:'Aufgaben',owner:'Zuständig',priority:'Priorität',type:'Typ',description:'Beschreibung',comments:'Kommentare',dependencies:'Abhängigkeiten',none:'Keine Angaben',unavailable:'Nicht verfügbar',readError:'Lesefehler',shared:'Gemeinsamer Tracker',loaded:'Aufgaben geladen',noPageTasks:'Keine Treffer auf dieser Seite. Weitere Seiten sind verfügbar.',current:'Aktueller Stand',utcDays:'Tagesstände nach UTC.',range:'Tagesverlauf',unassigned:'Unzugewiesen',ready:'Bereit',chartLabel:'Verlauf abgeschlossener und aller Aufgaben',closedLegend:'Abgeschlossen',totalLegend:'Alle Aufgaben' },
    en: { roadmaps:'Roadmaps',roadmapHint:'Each repository ROADMAP.md, read live from GitHub and joined with the Beads of each milestone.',fullText:'Full text',milestoneView:'Milestones',onGithub:'Open on GitHub',lastChanged:'last changed',verified:'verified',checklist:'Checklist',beadsProgress:'Beads',openBeads:'Open beads',currentMilestone:'Current',noRoadmap:'This repository has no ROADMAP.md.',noRoadmaps:'No roadmaps are shared.',roadmapUnavailable:'The roadmap could not be read from GitHub. Please try again later.',noRoadmapMilestones:'No vX.Y.Z milestones were found in this roadmap.',epicMissing:'epic missing in Beads',epic:'Epic',extraEpics:'Milestone epics only in Beads',extraEpicsHint:'These milestone epics are not in ROADMAP.md.',noChecklist:'No checklist in this milestone.',blocking:'blocking',moreBeads:'more open beads',trackerUnavailable:'Beads could not be read; progress shows the checklist only.',uncoveredOpen:'open beads hang on no milestone.',markPulled:'↑ pulled forward',markDeferred:'↓ deferred',markAhead:'↑ done ahead',fromVersion:'from',toVersion:'to',markPulledHint:'Pulled forward from a later milestone.',markDeferredHint:'Moved to a later milestone.',markAheadHint:'Done before this milestone is up.',showRoadmap:'Roadmap',state_done:'done',state_current:'current',state_planned:'planned',state_deferred:'deferred',state_unknown:'no state',milestones:'Milestones',milestonesHint:'Roadmap milestones per repository, ordered by the central roadmap.',phase:'Phase',noMilestones:'No milestones recorded yet.',uncovered:'without milestone',done:'done',milestoneCount:'milestones',allPhases:'All phases',resetFilters:'Reset filters',statusFilter:'Task status',selectAll:'Select all',deselectAll:'Deselect all',noneSelected:'None',selected:'selected',statusFilterHint:'Repositories with tasks in at least one selected status.',sortAscending:'Sort ascending',sortDescending:'Sort descending',matchingRepos:'repositories shown', areas:'Areas',areasHint:'Click an area to filter repositories and scopes.',allAreas:'Whole ecosystem',repoCount:'Repositories',scopes:'Scopes',labels:'Labels',types:'Types',searchScopes:'Search scopes …',scopeNote:'Scopes are labels or task types across all repositories. A task can carry several labels.',scope:'Scope',noScopes:'No scopes match this selection.',modules:'Modules',modulesHint:'Epics with the progress of their subtasks.',repoScopes:'Scopes in this repository',noModules:'No epics in this repository.',unfiled:'No module',truncated:'Very large tracker: not every task was evaluated.',scopesPartial:'Unreadable:',inRepos:'in',subtasks:'subtasks',refresh:'Refresh',logout:'Sign out',signedIn:'Signed in as',eyebrow:'Cloudflare · Beads',title:'Work at a glance.',intro:'Current tasks and their history, directly from the shared Beads data source.',history:'Task history',historySource:'Data source',archive:'Dolt archive',archiveNote:'Dolt archive · originally recorded days (Europe/Berlin). Historical repository coverage varies.',days:' days',table:'Table',ratio:'Progress = closed tasks ÷ all tasks. This measures task closure, not product readiness.',repositories:'Repositories',searchRepos:'Search repositories …',footer:'Cloudflare is the operational Beads data source.',readonly:'Read-only access · no task changes',close:'Close',searchTasks:'Search tasks …',more:'Load more',total:'All tasks',open:'Open',in_progress:'In progress',blocked:'Blocked',closed:'Closed',deferred:'Deferred',active:'Active',completion:'Progress',all:'All',allGroups:'All groups',loading:'Loading data …',failed:'Could not load data. Please try again.',login:'Sign in',unauthorized:'Sign in to view private Beads data.',partial:'Some repositories could not be read. Displayed totals are incomplete.',stale:'This snapshot is more than 15 minutes old.',updated:'Updated',noRepos:'No repositories match this selection.',noTasks:'No tasks match this selection.',noHistory:'No historical observations yet. History grows with daily captures.',date:'Date',tasks:'Tasks',owner:'Assignee',priority:'Priority',type:'Type',description:'Description',comments:'Comments',dependencies:'Dependencies',none:'No information',unavailable:'Unavailable',readError:'Read error',shared:'Shared tracker',loaded:'tasks loaded',noPageTasks:'No matches on this page. More pages are available.',current:'Current observation',utcDays:'Daily observations in UTC.',range:'Daily history',unassigned:'Unassigned',ready:'Ready',chartLabel:'History of closed and all tasks',closedLegend:'Closed',totalLegend:'All tasks' }
  };
  Object.assign(copy.de,{healthTitle:'Store-Zustand',healthHint:'Letzte stündliche Messung des Stores; nur für Betreiber sichtbar.',healthNone:'Noch keine stündliche Messung gespeichert.',healthSignal:'Messwert',healthValue:'Wert',healthLimit:'Grenze',healthStorage:'Speicher',healthGrowth:'Wachstum pro Tag',healthErrors:'Fehlerquote',healthLatency:'Schreiblatenz (max.)',healthRows:'Aufgaben · Ereignisse · Kommentare',healthRequests:'Anfragen im Intervall',healthBreached:'Grenze überschritten',healthOk:'im Rahmen',tabRoadmaps:'Roadmaps',tabRepo:'Repository',tabTasks:'Aufgaben',overviewTitle:'Roadmap-Meilensteine',overviewHint:'Je Repository der aktive Meilenstein, seine Schritte und was danach ansteht. Ein Klick auf eine Zeile öffnet die Roadmap.',repository:'Repository',sequence:'Verlauf',activeMilestone:'Aktiver Meilenstein',activeMilestones:'aktive Meilensteine',steps:'Schritte',nextMilestone:'Danach',before:'Davor',after:'Danach',allDone:'Alle Meilensteine erledigt.',noRoadmapShort:'keine ROADMAP.md',roadmapUnreadable:'Roadmap nicht lesbar',noRoadmapMilestonesShort:'keine Meilensteine im Format vX.Y.Z',id:'ID',titleCol:'Titel',status:'Status',stateCol:'Status',openShort:'offen',tasksAndModules:'Aufgaben & Module',legendDone:'erledigt',legendCurrent:'aktiv',legendPlanned:'geplant',legendDeferred:'zurückgestellt'});
  Object.assign(copy.en,{healthTitle:'Store health',healthHint:'Latest hourly sample of the store; visible to operators only.',healthNone:'No hourly sample is stored yet.',healthSignal:'Signal',healthValue:'Value',healthLimit:'Limit',healthStorage:'Storage',healthGrowth:'Growth per day',healthErrors:'Error rate',healthLatency:'Write latency (max)',healthRows:'Issues · events · comments',healthRequests:'Requests in interval',healthBreached:'threshold breached',healthOk:'within limits',tabRoadmaps:'Roadmaps',tabRepo:'Repository',tabTasks:'Tasks',overviewTitle:'Roadmap milestones',overviewHint:'For each repository the active milestone, its steps and what comes next. Click a row to open its roadmap.',repository:'Repository',sequence:'Sequence',activeMilestone:'Active milestone',activeMilestones:'active milestones',steps:'Steps',nextMilestone:'Next',before:'Before',after:'After',allDone:'All milestones are done.',noRoadmapShort:'no ROADMAP.md',roadmapUnreadable:'roadmap unreadable',noRoadmapMilestonesShort:'no vX.Y.Z milestones',id:'ID',titleCol:'Title',status:'Status',stateCol:'State',openShort:'open',tasksAndModules:'Tasks & modules',legendDone:'done',legendCurrent:'active',legendPlanned:'planned',legendDeferred:'deferred'});
  Object.assign(copy.de,{tabState:'Stand',stateTitle:'Stand des Produkts',stateHint:'Die generierte Seite der Wahrheit: Versionen je Kanal, Journey-Belege, offene P0/P1, CI-Minuten, Kosten und die Erfolgsmaße der Roadmap.',stateMissing:'Die Zustandsseite wurde noch nicht erzeugt.',stateGenerated:'erzeugt',stHeadline:'Kennzahlen',stMeasures:'Erfolgsmaße (Roadmap Abschnitt 13)',stProducts:'Produkte',stJourneys:'Journeys (Kandidatenstand)',stBeads:'Beads je Store',stBeadsLive:'Live aus dem Tracker; die Seite selbst meldet: ',stCollectors:'Quellen',stSignal:'Signal',stNow:'Jetzt',stTrend:'Trend',stSource:'Quelle',stBaseline:'Ausgangswert 16.10.',stCurrent:'Aktuell',stTarget:'Ziel',stProduct:'Produkt',stStable:'Stable (neuester Tag)',stLive:'Live',stPreview:'Preview (main VERSION)',stPreviewRev:'Preview-Revision',stJourney:'Journey',stTitle:'Titel',stReceipt:'Beleg',stFindings:'Befunde',stStore:'Store',stOpen:'Offen',stP0:'P0',stP1:'P1',stP0P1:'P0/P1',stBlocked:'Blockiert',stDeferred:'Zurückgestellt (P0/P1)',stUnmapped:'Ohne Meilenstein (P0/P1)',stNoThread:'Ohne Thread (P0/P1)',stCollector:'Quelle',stStatus:'Status',stNote:'Hinweis',stNoPreview:'kein Preview-Ziel'});
  Object.assign(copy.en,{tabState:'State',stateTitle:'Product state',stateHint:'The generated page of truth: versions per channel, journey receipts, open P0/P1, CI minutes, cost and the roadmap measures of success.',stateMissing:'The state page has not been generated yet.',stateGenerated:'generated',stHeadline:'Headline',stMeasures:'Measures of success (roadmap section 13)',stProducts:'Products',stJourneys:'Journeys (candidate state)',stBeads:'Beads per store',stBeadsLive:'Live from the tracker; the page itself reports: ',stCollectors:'Sources',stSignal:'Signal',stNow:'Now',stTrend:'Trend',stSource:'Source',stBaseline:'Baseline 2026-10-16',stCurrent:'Current',stTarget:'Target',stProduct:'Product',stStable:'Stable (newest tag)',stLive:'Live',stPreview:'Preview (main VERSION)',stPreviewRev:'Preview revision',stJourney:'Journey',stTitle:'Title',stReceipt:'Receipt',stFindings:'Findings',stStore:'Store',stOpen:'Open',stP0:'P0',stP1:'P1',stP0P1:'P0/P1',stBlocked:'Blocked',stDeferred:'Deferred (P0/P1)',stUnmapped:'Outside a milestone (P0/P1)',stNoThread:'Without thread (P0/P1)',stCollector:'Source',stStatus:'Status',stNote:'Note',stNoPreview:'no preview target'});
  let language = (navigator.language || 'de').startsWith('en') ? 'en' : 'de';
  // Display names come from the deployment (PORTFOLIO_LABELS); a missing name shows the raw key.
  const labelFor = (table, key) => { const v=(snapshot?.labels?.[table] || {})[key]; return typeof v === 'string' ? v : v ? (v[language] || v.en || Object.values(v)[0]) : undefined; };
  const groupName = (g) => labelFor('groups',g) || g;
  let scopeData, scopeRequest = 0, moduleRequest = 0;
  let authenticated = false, snapshot, days = 30, historySource = 'cloudflare', selectedRepo, taskPage, taskRequest = 0, issueRequest = 0, overviewRequest = 0, searchTimer;
  let repositorySort = {key:'name',direction:1};
  const repositoryStatuses = ['open','in_progress','blocked','deferred','closed'];
  let selectedRepositoryStatuses = new Set(repositoryStatuses);
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
    renderRepositoryStatusFilter();
    $('history-source').setAttribute('aria-label',t('historySource')); if (snapshot) render(); renderOverview(); if (view==='repo') renderRepoView(); if (stateData) renderState(); if (healthData) renderHealth(); if (taskPage) renderTasks(); if(selectedRepo) renderRepoHistory();
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
    renderHistorySources(); renderAreas(); renderRepositories(); renderScopes(); renderHistory(); if(selectedRepo) renderRepoHistory(); if(stateData) renderState();
  }

  function bar(pct) { const wrap=el('div',undefined,'progress'), b=el('span',undefined,'bar'), fill=el('i'); const v=Math.max(0,Math.min(100,Number(pct)||0)); fill.style.width=v+'%'; b.append(fill); wrap.append(b,el('span',num(v)+'%')); return wrap; }
  function renderAreas() {
    const root=$('areas'); clear(root);
    const selected=$('group').value, repos=(snapshot.repositories || []).filter(r=>!r.error);
    const areas=[['',repos]].concat([...new Set(repos.map(r=>r.group).filter(Boolean))].sort((a,b)=>groupName(a).localeCompare(groupName(b),language)).map(g=>[g,repos.filter(r=>r.group===g)]));
    areas.forEach(([g,list])=>{
      const c={total:0,closed:0,active:0,blocked:0}; list.forEach(r=>Object.keys(c).forEach(k=>c[k]+=Number(r.counts[k])||0));
      const button=el('button',undefined,'pill'); button.setAttribute('aria-pressed',String(g===selected));
      button.append(el('span',g ? groupName(g) : t('allAreas')),el('span',num(c.active)+' '+t('active')+' · '+num(c.total ? Math.round(100*c.closed/c.total) : 0)+'%','count'));
      button.title=num(list.length)+' '+t('repoCount')+' · '+num(c.blocked)+' '+t('blocked');
      button.addEventListener('click',()=>{ $('group').value=g; renderAreas(); renderRepositories(); renderScopes(); });
      root.append(button);
    });
  }
  const phaseLabel = (c) => { const name=c && labelFor('phases',c); return c ? c+(name ? ' · '+name : '') : ''; };
  const phaseRank = (c) => c && /^C\d+$/.test(c) ? Number(c.slice(1)) : 99;
  let roadmapList = [], roadmapData, roadmapFull = false, roadmapRepo, overviewGroup = '', overviewPhase = '', view = 'state', roadmapRound = 0;
  let stateData, stateRequest = 0;
  const roadmapCache = new Map(), roadmapPending = new Map();
  const finished = (m) => m.stateKind==='done' || Boolean(m.beads && m.beads.status==='closed') || (m.stateKind!=='current' && m.checklist.total>0 && m.checklist.done===m.checklist.total);
  const kindOf = (m) => m.current ? 'current' : finished(m) ? 'done' : m.stateKind==='deferred' ? 'deferred' : 'planned';
  const stepPct = (m) => m.checklist.total ? Math.round(100*m.checklist.done/m.checklist.total) : finished(m) ? 100 : 0;
  const msLabel = (m) => 'v'+m.version+' · '+m.name;
  function partition(data) {
    const list=data.milestones || [], index=list.findIndex(m=>m.current);
    if(index<0) return {before:list.filter(finished),current:null,after:list.filter(m=>!finished(m))};
    return {before:list.slice(0,index),current:list[index],after:list.slice(index+1)};
  }
  function fetchRoadmapData(id,fresh=false) {
    if(!fresh && roadmapCache.has(id)) return Promise.resolve(roadmapCache.get(id));
    if(!fresh && roadmapPending.has(id)) return roadmapPending.get(id);
    const request=get('/dashboard/api/roadmaps/'+encodeURIComponent(id)+(fresh ? '?fresh=true' : '')).then(
      data=>{ roadmapCache.set(id,data); return data; },
      err=>{ if(err.status===401) throw err; const data={id,loadError:err.status===503 ? 'unavailable' : 'failed'}; roadmapCache.set(id,data); return data; }
    ).finally(()=>roadmapPending.delete(id));
    roadmapPending.set(id,request); return request;
  }
  async function loadRoadmaps(freshId) {
    const round=++roadmapRound; roadmapCache.clear();
    if(!roadmapList.length) message($('roadmap-overview'),'loading');
    try { const data=await get('/dashboard/api/roadmaps'); if(round!==roadmapRound) return; roadmapList=data.repositories || []; }
    catch(err) { if(round===roadmapRound) { error($('roadmap-overview'),err); error($('repo-body'),err); } return; }
    const select=$('repo-select'); clear(select);
    roadmapList.forEach(r=>{ const o=el('option',r.name); o.value=r.id; select.append(o); });
    route(); renderOverview();
    // The shown repository loads first; the rest follow with bounded concurrency and fill the overview as they arrive.
    const ids=roadmapList.map(r=>r.id).sort((a,b)=>Number(b===roadmapRepo)-Number(a===roadmapRepo));
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
      while(cursor<ids.length && round===roadmapRound) {
        const id=ids[cursor++];
        try { await fetchRoadmapData(id,id===freshId); } catch(err) { if(round===roadmapRound) error($('roadmap-overview'),err); return; }
        if(round!==roadmapRound) return;
        renderOverview(); if(view==='repo' && roadmapRepo===id) renderRepoView();
      }
    }));
  }
  function summarize(data) {
    const {before,current,after}=partition(data), list=data.milestones || [];
    const next=after.find(m=>!finished(m) && kindOf(m)!=='deferred') || after[0] || null;
    const open=current && current.beads ? current.beads.openTotal : 0, blocking=current && current.beads ? current.beads.open.filter(b=>b.blocking).length : 0;
    return {list,before,current,after,next,done:list.filter(finished).length,open,blocking};
  }
  function strip(list) {
    const node=el('span',undefined,list.length>30?'strip dense':'strip'); node.setAttribute('aria-hidden','true');
    list.forEach(m=>{ const seg=el('i',undefined,kindOf(m)); seg.title=msLabel(m)+' · '+t('state_'+kindOf(m)); node.append(seg); }); return node;
  }
  function mini(done,total,pct) { const wrap=el('div',undefined,'mini'), b=el('span',undefined,'bar'), fill=el('i'); fill.style.width=Math.max(0,Math.min(100,pct))+'%'; b.append(fill); wrap.append(b,el('span',num(done)+'/'+num(total))); return wrap; }
  function pills(root,options,selected,onPick) {
    clear(root); options.forEach(([value,label,count])=>{ const b=el('button',undefined,'pill'); b.setAttribute('aria-pressed',String(value===selected)); b.append(el('span',label)); if(count!==undefined) b.append(el('span',num(count),'count')); b.addEventListener('click',()=>onPick(value)); root.append(b); });
  }
  function renderOverview() {
    const root=$('roadmap-overview'); if(!roadmapList.length) return;
    const rows=roadmapList.map(r=>{ const data=roadmapCache.get(r.id); return {r,data,info:data && !data.loadError && !data.missing ? summarize(data) : null}; });
    const groups=[...new Set(roadmapList.map(r=>r.group).filter(Boolean))].sort((a,b)=>groupName(a).localeCompare(groupName(b),language));
    pills($('overview-groups'),[['',t('allAreas'),roadmapList.length]].concat(groups.map(g=>[g,groupName(g),roadmapList.filter(r=>r.group===g).length])),overviewGroup,(g)=>{overviewGroup=g;renderOverview();});
    const phases=[...new Set(rows.map(x=>x.info && x.info.current && x.info.current.central).filter(Boolean))].sort((a,b)=>phaseRank(a)-phaseRank(b));
    pills($('overview-phases'),[['',t('allPhases')]].concat(phases.map(p=>[p,phaseLabel(p),rows.filter(x=>x.info && x.info.current && x.info.current.central===p).length])),overviewPhase,(p)=>{overviewPhase=p;renderOverview();});
    const shown=rows.filter(x=>(!overviewGroup || x.r.group===overviewGroup) && (!overviewPhase || (x.info && x.info.current && x.info.current.central===overviewPhase)));
    const rank=(x)=>!x.data ? 3 : x.info ? (x.info.current ? 0 : 1) : 2;
    shown.sort((a,b)=>rank(a)-rank(b) || (a.info && b.info ? phaseRank(a.info.current && a.info.current.central)-phaseRank(b.info.current && b.info.current.central) : 0) || a.r.name.localeCompare(b.r.name,language));
    const loaded=rows.filter(x=>x.data).length, active=shown.filter(x=>x.info && x.info.current).length, blocking=shown.reduce((n,x)=>n+(x.info ? x.info.blocking : 0),0);
    $('overview-summary').textContent=[num(shown.length)+' '+t('repoCount'),num(active)+' '+t('activeMilestones'),blocking ? num(blocking)+' '+t('blocking') : '',loaded<rows.length ? t('loading')+' '+num(loaded)+'/'+num(rows.length) : ''].filter(Boolean).join(' · ');
    const {table:tbl,body}=table(['repository','sequence','activeMilestone','steps','openBeads','nextMilestone']); tbl.className='compact overview';
    shown.forEach(({r,data,info})=>{
      const row=el('tr',undefined,'clickable'), name=el('td'), link=el('a',r.name); link.href='#repo='+encodeURIComponent(r.id); name.append(link,el('span',groupName(r.group),'sub')); row.append(name);
      row.addEventListener('click',(event)=>{ if(event.target.closest('a')) return; location.hash='#repo='+encodeURIComponent(r.id); });
      if(!info) { const cell=el('td',!data ? t('loading') : data.missing ? t('noRoadmapShort') : t('roadmapUnreadable'),'sub'+(data && data.loadError ? ' danger-text' : '')); cell.colSpan=5; row.append(cell); body.append(row); return; }
      const seq=el('td'); seq.append(strip(info.list),el('span',num(info.done)+'/'+num(info.list.length)+' '+t('done'),'sub')); row.append(seq);
      const cur=el('td',undefined,'wrap'), c=info.current;
      if(c) { const title=el('span',undefined,'ms-name'); title.append(el('span','v'+c.version,'vers'),document.createTextNode(c.name)); cur.append(title); if(c.central) cur.append(el('span',phaseLabel(c.central),'sub')); }
      else cur.append(el('span',info.list.length ? t('allDone') : t('noRoadmapMilestonesShort'),'sub'));
      row.append(cur);
      const steps=el('td'); if(c) steps.append(mini(c.checklist.done,c.checklist.total,stepPct(c))); else steps.append(el('span','—','sub')); row.append(steps);
      const open=el('td'); open.append(el('span',c && c.beads ? num(info.open) : '—')); if(info.blocking) open.append(el('span',num(info.blocking)+' '+t('blocking'),'sub danger-text')); row.append(open);
      const nx=el('td',undefined,'wrap'); if(info.next) { const title=el('span'); title.append(el('span','v'+info.next.version,'vers'),document.createTextNode(info.next.name)); nx.append(title); } else nx.append(el('span','—','sub')); row.append(nx);
      body.append(row);
    });
    clear(root);
    if(!shown.length) { message(root,'noMilestones'); return; }
    root.append(tbl);
  }
  function beadsTable(beads,repoId) {
    const {table:tbl,body}=table(['id','titleCol','status','priority','type']); tbl.className='compact';
    beads.forEach(b=>{
      const row=el('tr',undefined,'clickable'), idCell=el('td'), open=el('button',b.id,'link-button'); open.addEventListener('click',()=>openIssue(b,repoId)); idCell.append(open);
      const title=el('td',b.title,'wrap'); if(b.blocking) { title.append(document.createTextNode(' ')); title.append(el('span',t('blocking'),'badge blocked')); }
      row.append(idCell,title,el('td',t(b.status)),el('td','P'+b.priority),el('td',b.type));
      row.addEventListener('click',(event)=>{ if(!event.target.closest('button')) openIssue(b,repoId); }); body.append(row);
    });
    const wrap=el('div',undefined,'table-wrap'); wrap.append(tbl); return wrap;
  }
  function checklistOf(m) {
    const root=el('div'); if(!m.items.length) { root.append(el('p',t('noChecklist'),'sub')); return root; }
    let group, ul; m.items.forEach(item=>{ if(!ul || item.group!==group) { group=item.group; if(group) root.append(el('div',group,'rm-group')); ul=el('ul',undefined,'checklist'); root.append(ul); } const li=checkItem(item.done,item.text,item.marker); li.style.marginLeft=(Math.min(item.depth,4)*20)+'px'; ul.append(li); });
    return root;
  }
  function milestoneBody(m,data) {
    const root=el('div',undefined,'ms-body'), info=el('p',undefined,'sub'), epicId=(m.beads && m.beads.epic) || m.epic;
    const parts=[m.state ? t('stateCol')+': '+m.state : '',m.central ? t('phase')+' '+phaseLabel(m.central) : ''].filter(Boolean);
    if(parts.length) info.append(document.createTextNode(parts.join(' · ')));
    if(epicId) { info.append(document.createTextNode((parts.length ? ' · ' : '')+t('epic')+' ')); if(m.beads && m.beads.status) { const b=el('button',epicId,'link-button'); b.addEventListener('click',()=>openIssue({id:epicId,title:msLabel(m)},data.catalogId)); info.append(b); } else info.append(el('code',epicId)); }
    if(m.beads && m.beads.epicMissing) info.append(el('span',' · '+t('epicMissing'),'danger-text'));
    if(info.childNodes.length) root.append(info);
    const bars=el('div',undefined,'rm-bars'), c1=el('div'); c1.append(el('span',t('checklist')+' · '+num(m.checklist.done)+'/'+num(m.checklist.total),'sub'),bar(stepPct(m))); bars.append(c1);
    if(m.beads) { const c2=el('div'); c2.append(el('span',t('beadsProgress')+' · '+num(m.beads.counts.closed)+'/'+num(m.beads.counts.total)+(m.beads.counts.blocked ? ' · '+num(m.beads.counts.blocked)+' '+t('blocked') : ''),'sub'),bar(m.beads.counts.completion)); bars.append(c2); }
    root.append(bars,checklistOf(m));
    if(m.beads && m.beads.openTotal) {
      root.append(el('div',t('openBeads')+' · '+num(m.beads.openTotal),'rm-group'),beadsTable(m.beads.open,data.catalogId));
      if(m.beads.openTotal>m.beads.open.length) root.append(el('p','+ '+num(m.beads.openTotal-m.beads.open.length)+' '+t('moreBeads'),'sub'));
    }
    return root;
  }
  function milestoneRow(m,data) {
    const kind=kindOf(m), row=el('details',undefined,'ms-row '+kind), summary=el('summary'); row.id='ms-'+m.version;
    const title=el('span',undefined,'ms-title'); title.append(el('span',undefined,'chev'),el('span',undefined,'dot '+kind),el('span','v'+m.version,'vers'),el('span',m.name,'ms-name'));
    const ahead=m.items.filter(i=>i.marker && (i.marker.kind==='ahead' || i.marker.kind==='pulled')).length, moved=m.items.filter(i=>i.marker && i.marker.kind==='deferred').length;
    const badges=el('span',undefined,'ms-badges'); if(kind!=='planned') badges.append(el('span',t('state_'+kind),'badge'+(kind==='deferred' ? ' blocked' : '')));
    if(ahead) badges.append(el('span',num(ahead)+' '+t('markAhead'),'marker ahead')); if(moved) badges.append(el('span',num(moved)+' '+t('markDeferred'),'marker deferred'));
    const open=m.beads && m.beads.openTotal ? el('span',num(m.beads.openTotal)+' '+t('openShort'),'sub ms-open') : el('span','','ms-open');
    summary.append(title,badges,mini(m.checklist.done,m.checklist.total,stepPct(m)),open); row.append(summary);
    row.addEventListener('toggle',()=>{ if(row.open && row.childNodes.length===1) row.append(milestoneBody(m,data)); });
    return row;
  }
  function renderRepoView() {
    const root=$('repo-body'), meta=$('repo-meta'); clear(meta); $('roadmap-link').hidden=true;
    $('roadmap-mode').textContent=t(roadmapFull ? 'milestoneView' : 'fullText'); $('roadmap-mode').setAttribute('aria-pressed',String(roadmapFull));
    const source=roadmapList.find(r=>r.id===roadmapRepo);
    if(!source) { $('repo-name').textContent=t('tabRepo'); return message(root,roadmapRound ? 'noRoadmaps' : 'loading'); }
    $('repo-name').textContent=source.name; $('repo-select').value=source.id; $('tab-repo').href='#repo='+encodeURIComponent(source.id);
    const data=roadmapCache.get(source.id); roadmapData=data;
    if(!data) { message(root,'loading'); fetchRoadmapData(source.id).then(()=>{ if(roadmapRepo===source.id && view==='repo') renderRepoView(); renderOverview(); },err=>error(root,err)); return; }
    clear(root);
    if(data.loadError) return message(root,data.loadError==='unavailable' ? 'roadmapUnavailable' : 'failed');
    if(data.missing) return message(root,'noRoadmap');
    $('roadmap-link').hidden=!data.url; if(data.url) $('roadmap-link').href=data.url;
    meta.textContent=[groupName(data.group),data.lastChanged ? t('lastChanged')+' '+date(data.lastChanged) : '',data.lastVerified ? t('verified')+' '+data.lastVerified : '',t('updated')+' '+date(data.fetchedAt)].filter(Boolean).join(' · ');
    const notes=[]; if(data.error) notes.push(t('trackerUnavailable')); if(data.truncated) notes.push(t('truncated')); if(data.uncovered) notes.push(num(data.uncovered)+' '+t('uncoveredOpen'));
    if(notes.length) root.append(el('p',notes.join(' '),'notice error'));
    if(roadmapFull) { root.append(renderMarkdown(data.markdown)); return; }
    const list=data.milestones || []; if(!list.length) return root.append(el('p',t('noRoadmapMilestones'),'empty'));
    const sequence=el('ol',undefined,'sequence'); sequence.setAttribute('aria-label',t('sequence'));
    list.forEach(m=>{ const item=el('li',undefined,kindOf(m)), link=el('a','v'+m.version); link.href='#ms-'+m.version; link.title=m.name+' · '+t('state_'+kindOf(m));
      link.addEventListener('click',(event)=>{ event.preventDefault(); const target=document.getElementById('ms-'+m.version); if(!target) return; if(target.tagName==='DETAILS') target.open=true; const group=target.closest('details.ms-group'); if(group) group.open=true; target.scrollIntoView({behavior:'smooth',block:'start'}); });
      item.append(link); sequence.append(item); });
    root.append(sequence);
    const {before,current,after}=partition(data);
    if(before.length) {
      const group=el('details',undefined,'ms-group'), summary=el('summary',undefined,'section-label'); summary.append(el('span',undefined,'chev'),document.createTextNode(' '+t('before')+' · '+num(before.filter(finished).length)+'/'+num(before.length)+' '+t('done'))); group.append(summary);
      const rows=el('div',undefined,'ms-list'); before.forEach(m=>rows.append(milestoneRow(m,data))); group.append(rows); root.append(group);
    }
    root.append(el('div',t('activeMilestone'),'section-label'));
    const active=el('section',undefined,'ms-active');
    if(current) {
      active.id='ms-'+current.version; const head=el('div',undefined,'module-head'), title=el('h3'); title.append(el('span','v'+current.version,'vers'),document.createTextNode(current.name));
      const badges=el('span',undefined,'detail-labels'); badges.append(el('span',t('currentMilestone'),'badge current-badge')); head.append(title,badges); active.append(head,milestoneBody(current,data));
    } else active.append(el('p',t('allDone'),'empty'));
    root.append(active);
    if(after.length) { root.append(el('div',t('after')+' · '+num(after.length),'section-label')); const rows=el('div',undefined,'ms-list'); after.forEach(m=>rows.append(milestoneRow(m,data))); root.append(rows); }
    if((data.extraEpics || []).length) {
      root.append(el('div',t('extraEpics'),'section-label'),el('p',t('extraEpicsHint'),'sub'));
      root.append(beadsTable(data.extraEpics.map(e=>({id:e.id,title:e.title,status:e.status,priority:'–',type:'epic',blocking:false})),data.catalogId));
    }
  }
  async function loadState(fresh) {
    const request=++stateRequest; if(!stateData) message($('state-body'),'loading');
    try { const data=await get('/dashboard/api/state'+(fresh ? '?fresh=true' : '')); if(request!==stateRequest) return; stateData=data; renderState(); }
    catch(err) { if(request!==stateRequest) return; if(err.status===404) { $('tab-state').hidden=true; if(view==='state') location.replace('#roadmaps'); return; } error($('state-body'),err); }
  }
  function stateTable(headers,rows) {
    const {table:tbl,body}=table(headers); tbl.className='compact';
    rows.forEach(cells=>{ const row=el('tr'); cells.forEach((v,i)=>{ const td=el('td'); if(v && typeof v==='object' && v.strong) td.append(el('strong',v.strong)); else inline(v===null || v===undefined ? '—' : String(v),td); if(i===0 || i===2) td.className='wrap'; row.append(td); }); body.append(row); });
    const wrap=el('div',undefined,'table-wrap'); wrap.append(tbl); return wrap;
  }
  function stateBlock(root,titleKey,content,hint) { root.append(el('h3',t(titleKey),'block')); if(hint) root.append(el('p',hint,'sub')); root.append(content); }
  function renderState() {
    const root=$('state-body'); clear(root); const data=stateData || {};
    const link=$('state-link'); link.hidden=!(data.source && data.source.markdownUrl); if(!link.hidden) link.href=data.source.markdownUrl;
    if(data.missing || !data.page) { $('state-meta').textContent=t('stateHint'); message(root,'stateMissing'); return; }
    const page=data.page, run=page.run || {}, d=page.collectors_data || {};
    $('state-meta').textContent=page.date+' · '+t('stateGenerated')+' '+date(page.generated_at)+(run.host ? ' · '+run.host : '')+(run.workspace_revision ? ' · '+String(run.workspace_revision).slice(0,9) : '');
    stateBlock(root,'stHeadline',stateTable(['stSignal','stNow','stTrend','stSource'],(page.headline || []).map(r=>[r.label,r.display,r.trend,r.source])));
    stateBlock(root,'stMeasures',stateTable(['stSignal','stBaseline','stCurrent','stTarget','stTrend'],(page.measures || []).map(r=>[r.signal,r.baseline,r.display,r.target,r.trend])));
    if(d.products && d.products.status==='ok') stateBlock(root,'stProducts',stateTable(['stProduct','repository','stStable','stLive','stPreview','stPreviewRev'],d.products.data.map(p=>[
      p.core ? {strong:p.id} : p.id, p.repository, p.stable.tag || '—',
      p.live ? (p.live.version ? p.live.version+(p.live.revision ? ' @ '+String(p.live.revision).slice(0,9) : '') : 'n/a ('+p.live.error+')') : '—',
      p.preview.version || '—', p.preview.target ? (p.preview.revision ? String(p.preview.revision).slice(0,9) : 'n/a ('+p.preview.error+')') : t('stNoPreview')])));
    if(d.journeys && d.journeys.status==='ok') { const j=d.journeys.data; stateBlock(root,'stJourneys',stateTable(['stJourney','stTitle','stReceipt','stFindings'],j.rows.map(r=>[r.id,r.title,r.receipt,(r.findings || []).join(', ') || '—'])),
      (j.candidate_id || 'no candidate')+' · '+(j.status || '—')+' · '+j.verified+' / '+j.total+(j.revision ? ' · '+String(j.revision).slice(0,9) : '')); }
    const beads=d.beads;
    if(beads && beads.status==='ok') {
      const b=beads.data, pair=(n,m)=>num(n)+' ('+num(m)+')';
      stateBlock(root,'stBeads',stateTable(['stStore','stOpen','stP0','stP1','stBlocked','stDeferred','stUnmapped','stNoThread'],b.stores.filter(s=>!s.error).map(s=>[s.store,num(s.open_class),num(s.p0),num(s.p1),num(s.blocked),pair(s.deferred,s.deferred_p0p1),pair(s.unmapped,s.unmapped_p0p1),pair(s.without_thread,s.without_thread_p0p1)])
        .concat([[{strong:'total'},num(b.totals.open_class),num(b.totals.p0),num(b.totals.p1),num(b.totals.blocked),pair(b.totals.deferred,b.totals.deferred_p0p1),pair(b.totals.unmapped,b.totals.unmapped_p0p1),pair(b.totals.without_thread,b.totals.without_thread_p0p1)]])),b.note);
    } else if(snapshot && snapshot.repositories) {
      const repos=snapshot.repositories.filter(r=>!r.error).slice().sort((a,b)=>(b.counts.p0p1-a.counts.p0p1) || a.name.localeCompare(b.name));
      stateBlock(root,'stBeads',stateTable(['stStore','stOpen','stP0P1','stBlocked','deferred'],repos.map(r=>[r.name,num(r.counts.active),num(r.counts.p0p1),num(r.counts.blocked),num(r.counts.deferred)])),
        t('stBeadsLive')+(beads ? beads.reason || beads.status : '—'));
    }
    stateBlock(root,'stCollectors',stateTable(['stCollector','stStatus','stNote'],(page.collectors || []).map(c=>[c.id,c.status,c.reason || ''])));
  }
  function route() {
    const hash=location.hash; let match;
    if((match=/^#(?:repo|roadmap)=(.+)$/.exec(hash))) { view='repo'; roadmapRepo=decodeURIComponent(match[1]); }
    else if(hash==='#repo') { view='repo'; if(!roadmapRepo && roadmapList.length) roadmapRepo=roadmapList[0].id; }
    else if(hash==='#tasks') view='tasks';
    else if(hash==='#roadmaps') view='roadmaps';
    else if(/^#ms-/.test(hash)) return;
    else view='state';
    ['state','roadmaps','repo','tasks'].forEach(v=>{ $('view-'+v).hidden=v!==view; if(v===view) $('tab-'+v).setAttribute('aria-current','page'); else $('tab-'+v).removeAttribute('aria-current'); });
    if(view==='repo') renderRepoView();
    if(view==='state' && !stateData) loadState(false);
  }
  const INLINE = /(\x60+)([\s\S]*?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/;
  function safeHref(href) { try { const base=roadmapData && roadmapData.url || location.href; const url=new URL(href,base); return url.protocol==='https:' || url.protocol==='http:' ? url.href : null; } catch { return null; } }
  function inline(text,parent) {
    let s=String(text);
    while(s) {
      const m=INLINE.exec(s); if(!m){ parent.append(document.createTextNode(s)); break; }
      if(m.index) parent.append(document.createTextNode(s.slice(0,m.index)));
      if(m[1]) parent.append(el('code',m[2].trim()));
      else if(m[3] || m[4]) { const b=el('strong'); inline(m[3] || m[4],b); parent.append(b); }
      else if(m[5]) { const i=el('em'); inline(m[5],i); parent.append(i); }
      else { const label=m[6] || m[8], url=safeHref(m[7] || m[8]); if(url){ const a=el('a'); inline(label,a); a.href=url; a.target='_blank'; a.rel='noopener noreferrer'; parent.append(a); } else parent.append(document.createTextNode(label)); }
      s=s.slice(m.index+m[0].length);
    }
    return parent;
  }
  function markerOf(text) {
    let m=/\b(?:pulled forward|pulled ahead|vorgezogen)\b(?:\s+(?:from|aus|von)\s+v?(\d+\.\d+\.\d+))?/i.exec(text);
    if(m) return {kind:'pulled',target:m[1]};
    m=/\b(?:deferred|postponed|moved|verschoben|zurückgestellt)\b(?:\s+(?:to|into|nach|auf|in)\s+v?(\d+\.\d+\.\d+))?/i.exec(text);
    return m && (m[1] || !/^moved/i.test(m[0])) ? {kind:'deferred',target:m[1]} : null;
  }
  function markerBadge(marker) {
    const label=marker.kind==='ahead' ? t('markAhead') : marker.kind==='pulled' ? t('markPulled')+(marker.target ? ' '+t('fromVersion')+' v'+marker.target : '') : t('markDeferred')+(marker.target ? ' '+t('toVersion')+' v'+marker.target : '');
    const badge=el('span',label,'marker '+marker.kind); badge.title=t(marker.kind==='ahead' ? 'markAheadHint' : marker.kind==='pulled' ? 'markPulledHint' : 'markDeferredHint'); return badge;
  }
  function checkItem(done,text,marker) {
    const li=el('li',undefined,done ? 'done' : ''), box=el('input'); box.type='checkbox'; box.disabled=true; box.checked=done; box.setAttribute('aria-label',t(done ? 'closed' : 'open'));
    li.append(box,inline(text,el('span',undefined,'text'))); if(marker) li.append(markerBadge(marker)); return li;
  }
  function renderMarkdown(markdown) {
    const root=el('div',undefined,'markdown'), lines=String(markdown).replace(/\r\n?/g,'\n').split('\n'); let i=0;
    if(lines[0]==='---') { const end=lines.indexOf('---',1); if(end>0) i=end+1; }
    const isList=(l)=>/^\s*([-*+]|\d+[.)])\s+/.test(l), isTable=(n)=>/^\s*\|/.test(lines[n] || '') && /^\s*\|?\s*:?-{2,}/.test(lines[n+1] || '');
    const fence=/^\s*(\x60{3,}|~{3,})/, heading=/^(#{1,6})\s+(.*?)\s*#*\s*$/, rule=/^\s*([-*_])(\s*\1){2,}\s*$/;
    const startsBlock=(n)=>fence.test(lines[n]) || heading.test(lines[n]) || rule.test(lines[n]) || isList(lines[n]) || isTable(n) || /^\s*>/.test(lines[n]) || /^\s*<!--/.test(lines[n]);
    const split=(r)=>r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
    while(i<lines.length) {
      const line=lines[i]; let m;
      if(!line.trim()) { i++; continue; }
      if((m=fence.exec(line))) { const buf=[]; i++; while(i<lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]); i++; const pre=el('pre'); pre.append(el('code',buf.join('\n'))); root.append(pre); continue; }
      if(/^\s*<!--/.test(line)) { while(i<lines.length && !lines[i].includes('-->')) i++; i++; continue; }
      if((m=heading.exec(line))) { root.append(inline(m[2],el('h'+Math.min(6,m[1].length+2)))); i++; continue; }
      if(rule.test(line)) { root.append(el('hr')); i++; continue; }
      if(isTable(i)) {
        const rows=[]; while(i<lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const wrap=el('div',undefined,'table-wrap'), tbl=el('table'), thead=el('thead'), head=el('tr'), body=el('tbody');
        split(rows[0]).forEach(c=>{ const th=el('th'); th.scope='col'; head.append(inline(c,th)); }); thead.append(head);
        rows.slice(2).forEach(r=>{ const tr=el('tr'); split(r).forEach(c=>tr.append(inline(c,el('td')))); body.append(tr); });
        tbl.append(thead,body); wrap.append(tbl); root.append(wrap); continue;
      }
      if(/^\s*>/.test(line)) { const buf=[]; while(i<lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/,'')); const quote=el('blockquote'); quote.append(...renderMarkdown(buf.join('\n')).childNodes); root.append(quote); continue; }
      if(isList(line)) {
        const stack=[];
        while(i<lines.length) {
          const l=lines[i];
          if(!l.trim()) { if(isList(lines[i+1] || '') || /^\s{2,}\S/.test(lines[i+1] || '')) { i++; continue; } break; }
          const item=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
          if(item) {
            const indent=item[1].replace(/\t/g,'  ').length, ordered=/\d/.test(item[2]);
            while(stack.length && indent<stack[stack.length-1].indent) stack.pop();
            let top=stack[stack.length-1];
            if(!top || indent>top.indent) { const list=el(ordered ? 'ol' : 'ul'); if(top && top.list.lastElementChild) top.list.lastElementChild.append(list); else root.append(list); top={indent,list}; stack.push(top); }
            const task=/^\[( |x|X)\]\s+(.*)$/.exec(item[3]);
            if(task) { const li=checkItem(task[1]!==' ',task[2],markerOf(task[2])); li.classList.add('task-item'); top.list.append(li); }
            else top.list.append(inline(item[3],el('li')));
          } else if(stack.length && /^\s+\S/.test(l)) { const last=stack[stack.length-1].list.lastElementChild; if(last) inline(' '+l.trim(),last.querySelector('.text') || last); }
          else break;
          i++;
        }
        continue;
      }
      const buf=[]; while(i<lines.length && lines[i].trim() && !(buf.length && startsBlock(i))) buf.push(lines[i++].trim());
      root.append(inline(buf.join(' '),el('p')));
    }
    return root;
  }
  const mib = (b) => Number.isFinite(Number(b)) ? (Number(b)/1048576).toLocaleString(language,{maximumFractionDigits:1})+' MiB' : '—';
  const pct = (r) => Number.isFinite(Number(r)) ? (Number(r)*100).toLocaleString(language,{maximumFractionDigits:2})+' %' : '—';
  let healthData;
  async function loadHealth() {
    try { healthData=await get('/dashboard/api/health'); $('health-section').hidden=false; renderHealth(); }
    catch(err) { healthData=undefined; $('health-section').hidden=true; }
  }
  function renderHealth() {
    if(!healthData) return; const root=$('health-body'); clear(root); const s=healthData.sample, lim=healthData.thresholds || {}, hit=new Set(healthData.breached || []);
    $('health-meta').textContent=t('healthHint')+(s ? ' · '+date(s.at) : '');
    if(!s) { message(root,'healthNone'); return; }
    const state=(k)=>hit.has(k) ? {strong:t('healthBreached')} : t('healthOk');
    root.append(stateTable(['healthSignal','healthValue','healthLimit','status'],[
      [t('healthStorage'),mib(s.storage_bytes),mib(lim.storage_bytes),state('storage_bytes')],
      [t('healthGrowth'),healthData.growth_bytes_per_day===null || healthData.growth_bytes_per_day===undefined ? '—' : mib(healthData.growth_bytes_per_day),mib(lim.storage_growth_bytes_per_day),state('storage_growth')],
      [t('healthErrors'),pct(s.error_rate)+' · '+num(s.errors)+'/'+num(s.requests),pct(lim.error_rate),state('error_rate')],
      [t('healthLatency'),num(s.write_latency_ms && s.write_latency_ms.max)+' ms',num(lim.write_latency_ms)+' ms',state('write_latency_ms')],
      [t('healthRows'),[s.rows?.issues,s.rows?.events,s.rows?.comments].map(num).join(' · '),'—','—']]));
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
    const {table:tbl,body}=table(['titleCol','status','subtasks','active','completion']); tbl.className='compact';
    const draw=(m,depth)=>{
      const row=el('tr',undefined,'clickable'), name=el('td',undefined,'wrap'), title=el('button',m.title,'link-button'); name.style.paddingLeft=(10+Math.min(depth,4)*18)+'px';
      title.addEventListener('click',()=>openIssue({id:m.id,title:m.title})); name.append(title,el('span',m.id+' · P'+m.priority+(m.assignee ? ' · '+m.assignee : ''),'sub'));
      const progress=el('td'); progress.append(bar(m.counts.completion));
      row.append(name,el('td',t(m.status)),el('td',num(m.counts.total)),el('td',num(m.counts.active)+(m.counts.blocked ? ' · '+num(m.counts.blocked)+' '+t('blocked') : ''),m.counts.blocked ? 'danger-text' : ''),progress);
      row.addEventListener('click',(event)=>{ if(!event.target.closest('button')) openIssue({id:m.id,title:m.title}); }); body.append(row);
      (children.get(m.id) || []).forEach(c=>draw(c,depth+1));
    };
    (children.get('') || []).forEach(m=>draw(m,0));
    if(data.unfiled && data.unfiled.total) { const row=el('tr'), progress=el('td'); progress.append(bar(data.unfiled.completion)); row.append(el('td',t('unfiled'),'wrap'),el('td','—'),el('td',num(data.unfiled.total)),el('td',num(data.unfiled.active)),progress); body.append(row); }
    if(body.rows.length) { const wrap=el('div',undefined,'table-wrap'); wrap.append(tbl); root.append(wrap); } else root.append(el('p',t('noModules'),'empty'));
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
  function updateRepositoryStatusSummary() {
    const count=selectedRepositoryStatuses.size;
    $('repo-status-summary').textContent=t('statusFilter')+' · '+(count===repositoryStatuses.length ? t('all') : count===0 ? t('noneSelected') : num(count)+' '+t('selected'));
  }
  function renderRepositoryStatusFilter() {
    const options=$('repo-status-options'); clear(options);
    repositoryStatuses.forEach(status=>{
      const label=el('label'), input=el('input'); input.type='checkbox'; input.value=status; input.checked=selectedRepositoryStatuses.has(status);
      input.addEventListener('change',()=>{
        if(input.checked) selectedRepositoryStatuses.add(status); else selectedRepositoryStatuses.delete(status);
        updateRepositoryStatusSummary(); if(snapshot) renderRepositoryRows();
      }); label.append(input,el('span',t(status))); options.append(label);
    });
    updateRepositoryStatusSummary();
  }
  function renderRepositories() {
    clear($('repositories'));
    const {table:tbl}=table([]), titles=tbl.tHead.rows[0];
    tbl.className='repository-table';
    repositoryColumns.forEach(key=>{
      const th=el('th'), button=el('button',undefined,'column-sort'); th.scope='col'; th.dataset.column=key;
      button.append(el('span',t(repositoryLabel(key))),el('span',undefined,'sort-indicator'));
      button.lastChild.setAttribute('aria-hidden','true');
      button.addEventListener('click',()=>{
        repositorySort={key,direction:repositorySort.key===key ? -repositorySort.direction : key==='name' ? 1 : -1};
        renderRepositoryRows();
      }); th.append(button); titles.append(th);
    });
    $('repositories').append(tbl); renderRepositoryRows();
  }
  function renderRepositoryRows() {
    const query=$('repo-search').value.trim().toLocaleLowerCase(language), group=$('group').value;
    const all=snapshot.repositories || [];
    const repos=all.filter(repo=>{
      if(group && repo.group!==group) return false;
      if(!(repo.name+' '+repo.id+' '+repo.tracker+' '+(repo.aliases || []).map(a=>typeof a==='string' ? a : a.name || a.id).join(' ')).toLocaleLowerCase(language).includes(query)) return false;
      // The all-selected default is unrestricted, including empty or unavailable repositories.
      if(selectedRepositoryStatuses.size===repositoryStatuses.length) return true;
      return !repo.error && [...selectedRepositoryStatuses].some(status=>Number(repo.counts[status])>0);
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
  async function refresh() { const request=++overviewRequest; $('refresh').disabled=true; $('refresh').textContent=t('loading'); if(!snapshot) $('notice').textContent=t('loading'); try {const data=await get('/dashboard/api/overview'); if(request!==overviewRequest)return; authenticated=true; snapshot=data; render(); renderOverview(); loadScopes(); loadHealth();} catch(err) {if(request===overviewRequest) { $('notice').classList.add('error'); error($('notice'),err); }} finally {if(request===overviewRequest){$('refresh').disabled=false;$('refresh').textContent=t('refresh');}} }
  function openRepo(repo) {selectedRepo=repo;if(snapshot) renderRepoHistory();taskPage=undefined;$('repository-title').textContent=repo.name;$('task-search').value='';$('task-status').value='all';$('repository-dialog').showModal();loadModules(repo);loadTasks();}
  async function loadTasks(more=false) { const request=++taskRequest; const repo=selectedRepo; if(!repo)return; $('more-tasks').disabled=true; if(!more)message($('tasks'),'loading'); const params=new URLSearchParams({status:$('task-status').value,q:$('task-search').value}); if(more && taskPage && taskPage.nextCursor)params.set('cursor',taskPage.nextCursor);
    try{ const data=await get('/dashboard/api/repositories/'+encodeURIComponent(repo.id)+'/issues?'+params); if(request!==taskRequest || selectedRepo!==repo)return;taskPage={...data,items:more ? [...taskPage.items,...data.items] : data.items};renderTasks();}catch(err){if(request===taskRequest){error($('tasks'),err);$('more-tasks').hidden=true;}}finally{if(request===taskRequest)$('more-tasks').disabled=false;}
  }
  function renderTasks() {
    clear($('tasks')); $('task-summary').textContent=num(taskPage.items.length)+' '+t('loaded');
    if(!taskPage.items.length) message($('tasks'),taskPage.nextCursor ? 'noPageTasks' : 'noTasks');
    else {
      const {table:tbl,body}=table(['id','titleCol','status','priority','owner','updated']); tbl.className='compact';
      taskPage.items.forEach(issue=>{ const row=el('tr',undefined,'clickable'), idCell=el('td'), open=el('button',issue.id,'link-button'); open.addEventListener('click',()=>openIssue(issue)); idCell.append(open);
        row.append(idCell,el('td',issue.title,'wrap'),el('td',t(issue.status),issue.status==='blocked' ? 'danger-text' : ''),el('td','P'+issue.priority),el('td',issue.assignee || t('unassigned')),el('td',date(issue.updated_at)));
        row.addEventListener('click',(event)=>{ if(!event.target.closest('button')) openIssue(issue); }); body.append(row); });
      const wrap=el('div',undefined,'table-wrap'); wrap.append(tbl); $('tasks').append(wrap);
    }
    $('more-tasks').hidden=!taskPage.nextCursor;
  }
  async function openIssue(issue,repoId) {const request=++issueRequest;$('issue-title').textContent=issue.title;message($('issue-detail'),'loading');$('issue-dialog').showModal();try{const data=await get('/dashboard/api/repositories/'+encodeURIComponent(repoId || selectedRepo.id)+'/issues/'+encodeURIComponent(issue.id));if(request!==issueRequest)return;renderIssue(data.issue || data);}catch(err){if(request===issueRequest)error($('issue-detail'),err);}}
  function renderIssue(issue) {const root=$('issue-detail');clear(root);const grid=el('div',undefined,'detail-grid');[['tasks',issue.id],['priority','P'+issue.priority],['owner',issue.assignee || issue.owner],['type',issue.issue_type],['updated',date(issue.updated_at)],['all',t(issue.status)]].forEach(([key,value])=>{const item=el('div',t(key));item.append(el('strong',value || t('none')));grid.append(item);});root.append(grid);const labels=el('div',undefined,'detail-labels');(issue.labels || []).forEach(l=>labels.append(el('span',l,'badge')));root.append(labels,el('h3',t('description')),el('p',issue.description || t('none'),'detail-description')); const deps=issue.dependencies || [];root.append(el('h3',t('dependencies')));if(Array.isArray(deps) && deps.length){const ul=el('ul');deps.forEach(d=>ul.append(el('li',typeof d==='string' ? d : (d.depends_on_id || d.id || '')+' · '+(d.dependency_type || d.type || ''))));root.append(ul);}else root.append(el('p',t('none')));root.append(el('h3',t('comments')));(issue.comments || []).forEach(c=>{const article=el('article',undefined,'comment');article.append(el('strong',c.author || t('none')),el('span',date(c.created_at),'sub'),el('p',c.text || c.body || ''));root.append(article);});if(!(issue.comments || []).length)root.append(el('p',t('none')));}
  $('language').addEventListener('click',()=>{language=language==='de'?'en':'de';localize();}); $('refresh').addEventListener('click',()=>{refresh(); loadRoadmaps(view==='repo' ? roadmapRepo : undefined); if(view==='state') loadState(true);});
  $('repo-select').addEventListener('change',()=>{ location.hash='#repo='+encodeURIComponent($('repo-select').value); }); $('roadmap-mode').addEventListener('click',()=>{roadmapFull=!roadmapFull;renderRepoView();});
  $('repo-tasks').addEventListener('click',()=>{ const source=roadmapList.find(r=>r.id===roadmapRepo); if(source) openRepo({id:source.catalogId,name:source.name}); }); window.addEventListener('hashchange',route);
  ['repo-search','group'].forEach(id=>$(id).addEventListener(id==='repo-search'?'input':'change',()=>{if(snapshot){renderRepositories();if(id==='group'){renderAreas();renderScopes();}}}));
  $('reset-repository-filters').addEventListener('click',()=>{selectedRepositoryStatuses=new Set(repositoryStatuses);renderRepositoryStatusFilter();$('repo-search').value='';$('group').value='';if(snapshot){renderRepositories();renderAreas();renderScopes();}});
  ['select-all-statuses','deselect-all-statuses'].forEach(id=>$(id).addEventListener('click',()=>{
    selectedRepositoryStatuses=new Set(id==='select-all-statuses' ? repositoryStatuses : []);
    renderRepositoryStatusFilter(); if(snapshot) renderRepositoryRows();
  }));
  document.addEventListener('pointerdown',event=>{if(!$('repo-status-filter').contains(event.target))$('repo-status-filter').open=false;});
  $('repo-status-filter').addEventListener('keydown',event=>{if(event.key==='Escape'){$('repo-status-filter').open=false;$('repo-status-summary').focus();event.preventDefault();}});
  ['scope-search','scope-kind'].forEach(id=>$(id).addEventListener(id==='scope-search'?'input':'change',()=>{if(snapshot)renderScopes();}));
  document.querySelectorAll('.range').forEach(button=>button.addEventListener('click',()=>{days=Number(button.dataset.days);document.querySelectorAll('.range').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(snapshot)renderHistory();}));
  $('history-source').addEventListener('change',()=>{historySource=$('history-source').value;renderHistorySources();renderHistory();if(selectedRepo)renderRepoHistory();});
  $('table-toggle').addEventListener('click',()=>{const show=$('history-table').hidden;$('history-table').hidden=!show;$('chart').hidden=show;$('table-toggle').setAttribute('aria-pressed',String(show));});
  $('close-repository').addEventListener('click',()=>$('repository-dialog').close());$('close-issue').addEventListener('click',()=>$('issue-dialog').close());
  $('repository-dialog').addEventListener('close',()=>{++taskRequest;++moduleRequest;selectedRepo=undefined;});$('issue-dialog').addEventListener('close',()=>++issueRequest);
  $('task-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadTasks(),300);});$('task-status').addEventListener('change',()=>loadTasks());$('more-tasks').addEventListener('click',()=>loadTasks(true));
  localize(); route(); refresh(); loadRoadmaps();
})();
`;
