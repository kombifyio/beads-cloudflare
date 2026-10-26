/** Browser code remains a separate same-origin resource under the dashboard CSP. */
export const dashboardScript = String.raw`
(() => {
  'use strict';
  const copy = {
    de: {
      tabToday:'Heute',tabProjects:'Projekte',tabMetrics:'Kennzahlen',tabRoadmaps:'Roadmaps',tabState:'Stand',tabRepo:'Repository',refresh:'Aktualisieren',logout:'Abmelden',signedIn:'Angemeldet als',loading:'Daten werden geladen …',failed:'Daten konnten nicht geladen werden. Bitte erneut versuchen.',login:'Anmelden',unauthorized:'Bitte anmelden, um die privaten Beads-Daten zu sehen.',partial:'Nicht alle Tracker konnten gelesen werden; Summen sind unvollständig:',stale:'Dieser Datenstand ist älter als 15 Minuten.',updated:'Stand',footer:'Cloudflare ist die operative Beads-Datenquelle.',readonly:'Lesender Zugriff · keine Aufgabenänderungen',close:'Schließen',
      area:'Bereich',repository:'Repository',search:'Suche',searchWork:'Titel, ID oder Label …',resetFilters:'Filter zurücksetzen',allAreas:'Alle Bereiche',allRepos:'Alle Repositories',filterShown:'{n} von {m} offenen Beads',filterSearchNote:'Die Suche gilt für Listen, nicht für Zu- und Abgänge.',
      todayTitle:'Heute · {date}',sumReady:'{n} Beads sind bereit',sumP0:', davon {n} kritisch (P0)',sumAttention:'. {n} brauchen Aufmerksamkeit',sumWorking:', {n} sind in Arbeit',sumDone:'. Heute abgeschlossen: {n}.',sumNone:'Keine offene Arbeit in dieser Auswahl.',
      kpiOpen:'Offene Arbeit',kpiOpenSub:'{net} netto in 7 Tagen',kpiP0:'Kritisch (P0)',kpiP0Sub:'dazu {n} P1',kpiWorking:'In Arbeit',kpiWorkingSub:'{n} mit aktivem Claim',kpiAttention:'Braucht Aufmerksamkeit',kpiAttentionSub:'{n} warten auf Abhängigkeiten',kpiToday:'Heute abgeschlossen',kpiTodaySub:'gestern {n}',kpiWeek:'Erledigt · 7 Tage',kpiWeekSub:'{delta} zur Vorwoche',
      focusTitle:'Als Nächstes erledigen',focusHint:'Bereit, nicht blockiert und von niemandem in Arbeit: zuerst Überfälliges, dann nach Priorität, freigegebener Arbeit und Alter.',attentionTitle:'Braucht Aufmerksamkeit',attentionHint:'Festgefahren, wartend oder eine Entscheidung offen.',workingTitle:'Gerade in Arbeit',workingHint:'Wer woran arbeitet und seit wann.',doneTitle:'Abgeschlossen',doneSummary:'{done} erledigt und {dropped} aussortiert in den letzten 7 Tagen.',showDropped:'Aussortierte zeigen',showMore:'Alle {n} zeigen',showLess:'Weniger zeigen',
      noFocus:'Gerade ist nichts bereit. Sieh unter „Braucht Aufmerksamkeit“ nach.',noAttention:'Nichts hängt fest.',noWorking:'Gerade arbeitet niemand an einer Aufgabe.',noDone:'In den letzten 7 Tagen wurde in dieser Auswahl nichts abgeschlossen.',dropped:'aussortiert',
      chipOverdue:'überfällig',chipDue:'fällig {when}',chipUnblocks:'gibt {n} frei',chipStale:'{n} Tage unverändert',chipAge:'seit {n} Tagen offen',chipUnassigned:'ohne Zuständige',
      rsLapsed:'Liegen geblieben',rsLapsedDetail:'zuletzt geändert {when} · {who}',rsBlocked:'Blockiert',rsDecision:'Entscheidung offen',rsWaiting:'Wartet',liveClaim:'aktiver Claim',noClaim:'ohne Claim',since:'seit {when}',updatedWhen:'geändert {when}',today:'Heute',yesterday:'Gestern',priority:'Priorität',
      projectsTitle:'Projekte und Meilensteine',projectsHint:'Ein Meilenstein ist ein Beads-Meilenstein oder ein Epic mit dem Meilenstein-Label; sein Fortschritt zählt die abgeschlossenen Beads darunter. Klick auf eine Phase filtert die Liste.',showClosedMilestones:'Abgeschlossene zeigen',milestones:'Meilensteine',projectsSummary:'{open} offen, davon {closable} mit allen Beads erledigt · {done} abgeschlossen · {uncovered} offene Beads hängen an keinem Meilenstein.',msClosable:'alle Beads erledigt',allPhases:'Alle Phasen',noPhase:'Ohne Phase',phaseMeta:'{done}/{total} Meilensteine',noMilestones:'Keine Meilensteine für diese Auswahl.',msActive:'aktiv',msPlanned:'geplant',msDone:'erledigt',colMilestone:'Meilenstein',colPhase:'Phase',colState:'Status',colProgress:'Fortschritt',colOpenBeads:'Offen',blockedShort:'blockiert',inProgressShort:'in Arbeit',
      metricsTitle:'Kennzahlen',metricsHint:'Zufluss, Abschluss und Rückstand. Abschluss misst erledigte Arbeit, nicht Produktreife.',mCreated:'Neu',mDone:'Erledigt',mDropped:'Aussortiert',mNet:'Rückstand netto',mRate:'Ø erledigt pro Tag',mAge:'Medianalter offen',mDays:'{n} Tage',mWindow:'in {n} Tagen',mNetGood:'Rückstand sinkt',mNetBad:'Rückstand wächst',mAgeSub:'Tage seit Anlage',
      flowTitle:'Neu und erledigt pro Tag',flowHint:'Aussortiertes zählt nicht als erledigt. Tage nach UTC.',legendDone:'Erledigt',legendCreated:'Neu',table:'Tabelle',flowNote:'Im Zeitraum aussortiert: {n} (nicht im Diagramm).',backlogTitle:'Offene Beads im Verlauf',backlogHint:'Tägliche Messung aller aktiven Beads (Epics eingeschlossen), nicht rückgerechnet.',backlogFiltered:'Für dieses Repository gibt es keine eigene Tagesmessung; der Verlauf zeigt die Auswahl ohne Repository-Filter.',backlogOpen:'Offen',archive:'Dolt-Archiv',archiveNote:'Dolt-Archiv · ursprünglich erfasste Tage (Europe/Berlin).',utcDays:'Tagesstände nach UTC.',noHistory:'Noch keine historischen Beobachtungen. Der Verlauf wächst mit den täglichen Erfassungen.',current:'aktuell',
      repositories:'Repositories',repoMetricsHint:'Klick auf eine Zeile zeigt die Arbeit dieses Repositorys unter „Heute“. Geteilte Tracker werden über das konfigurierte Repository-Label aufgeteilt.',colOpen:'Offen',colP0:'P0',colP1:'P1',colWorking:'In Arbeit',colAttention:'Aufmerksamkeit',colCreated7:'Neu 7 T',colDone7:'Erledigt 7 T',colNet7:'Netto 7 T',sortAscending:'Aufsteigend sortieren',sortDescending:'Absteigend sortieren',noRepos:'Keine Repositories für diese Auswahl.',
      roadmaps:'Roadmaps',roadmapHint:'ROADMAP.md jedes Repositorys, live aus GitHub gelesen und mit den Beads je Meilenstein verknüpft.',fullText:'Volltext',milestoneView:'Meilensteine',onGithub:'Auf GitHub öffnen',lastChanged:'zuletzt geändert',verified:'geprüft',checklist:'Checkliste',beadsProgress:'Beads',openBeads:'Offene Beads',currentMilestone:'Aktuell',noRoadmap:'Dieses Repository hat keine ROADMAP.md.',noRoadmaps:'Keine Roadmaps freigegeben.',roadmapUnavailable:'Die Roadmap konnte nicht von GitHub gelesen werden. Bitte später erneut versuchen.',noRoadmapMilestones:'In dieser Roadmap wurden keine Meilensteine im Format vX.Y.Z gefunden.',epicMissing:'Epic fehlt in Beads',epic:'Epic',extraEpics:'Meilenstein-Epics nur in Beads',extraEpicsHint:'Diese Meilenstein-Epics stehen nicht in der ROADMAP.md.',noChecklist:'Keine Checkliste in diesem Meilenstein.',blocking:'blockierend',moreBeads:'weitere offene Beads',trackerUnavailable:'Beads konnten nicht gelesen werden; der Fortschritt zeigt nur die Checkliste.',uncoveredOpen:'offene Beads hängen an keinem Meilenstein.',markPulled:'↑ vorgezogen',markDeferred:'↓ verschoben',markAhead:'↑ vorab erledigt',fromVersion:'aus',toVersion:'nach',markPulledHint:'Aus einem späteren Meilenstein vorgezogen.',markDeferredHint:'In einen späteren Meilenstein verschoben.',markAheadHint:'Erledigt, bevor dieser Meilenstein an der Reihe ist.',state_done:'erledigt',state_current:'aktuell',state_planned:'geplant',state_deferred:'zurückgestellt',state_unknown:'ohne Status',phase:'Phase',done:'erledigt',overviewTitle:'Roadmap-Meilensteine',overviewHint:'Je Repository der aktive Meilenstein, seine Schritte und was danach ansteht. Klick auf eine Zeile öffnet die Roadmap.',sequence:'Verlauf',activeMilestone:'Aktiver Meilenstein',activeMilestones:'aktive Meilensteine',steps:'Schritte',nextMilestone:'Danach',before:'Davor',after:'Danach',allDone:'Alle Meilensteine erledigt.',noRoadmapShort:'keine ROADMAP.md',roadmapUnreadable:'Roadmap nicht lesbar',noRoadmapMilestonesShort:'keine Meilensteine im Format vX.Y.Z',repoCount:'Repositories',tasksAndModules:'Aufgaben & Module',legendDoneMs:'erledigt',legendCurrent:'aktiv',legendPlanned:'geplant',legendDeferred:'zurückgestellt',openShort:'offen',stateCol:'Status',
      stateTitle:'Stand des Produkts',stateHint:'Generierter Zustandsbericht aus dem konfigurierten Repository: Kennzahlen, Ziele, Produktversionen, Journeys und Beads je Store.',stateMissing:'Die Zustandsseite wurde noch nicht erzeugt.',stateGenerated:'erzeugt',stHeadline:'Kennzahlen',stMeasures:'Erfolgsmaße',stProducts:'Produkte',stJourneys:'Journeys',stBeads:'Beads je Store',stBeadsLive:'Live aus dem Tracker; die Seite selbst meldet: ',stCollectors:'Quellen',stSignal:'Signal',stNow:'Jetzt',stTrend:'Trend',stSource:'Quelle',stBaseline:'Ausgangswert',stCurrent:'Aktuell',stTarget:'Ziel',stProduct:'Produkt',stStable:'Stable (neuester Tag)',stLive:'Live',stPreview:'Preview',stPreviewRev:'Preview-Revision',stJourney:'Journey',stTitle:'Titel',stReceipt:'Beleg',stFindings:'Befunde',stStore:'Store',stOpen:'Offen',stP0:'P0',stP1:'P1',stP0P1:'P0/P1',stBlocked:'Blockiert',stDeferred:'Zurückgestellt (P0/P1)',stUnmapped:'Ohne Meilenstein (P0/P1)',stNoThread:'Ohne Thread (P0/P1)',stCollector:'Quelle',stStatus:'Status',stNote:'Hinweis',stNoPreview:'kein Preview-Ziel',
      healthTitle:'Store-Zustand',healthHint:'Letzte stündliche Messung des Stores; nur für Betreiber sichtbar.',healthNone:'Noch keine stündliche Messung gespeichert.',healthSignal:'Messwert',healthValue:'Wert',healthLimit:'Grenze',healthStorage:'Speicher',healthGrowth:'Wachstum pro Tag',healthErrors:'Fehlerquote',healthLatency:'Schreiblatenz (max.)',healthRows:'Aufgaben · Ereignisse · Kommentare',healthRequests:'Anfragen im Intervall',healthBreached:'Grenze überschritten',healthOk:'im Rahmen',
      scopes:'Scopes',labels:'Labels',types:'Typen',searchScopes:'Scope suchen …',scopeNote:'Labels oder Aufgabentypen über alle Repositories. Eine Aufgabe kann mehrere Labels tragen.',scope:'Scope',noScopes:'Keine Scopes für diese Auswahl.',scopesPartial:'Nicht lesbar:',
      modules:'Module',modulesHint:'Epics mit dem Fortschritt ihrer Unteraufgaben.',repoScopes:'Scopes in diesem Repository',noModules:'Keine Epics in diesem Repository.',unfiled:'Ohne Modul',truncated:'Sehr großer Tracker: nicht alle Aufgaben wurden ausgewertet.',subtasks:'Unteraufgaben',history:'Aufgabenverlauf',searchTasks:'Aufgaben suchen …',more:'Weitere laden',loaded:'Aufgaben geladen',noTasks:'Keine Aufgaben für diese Auswahl.',noPageTasks:'Keine Treffer auf dieser Seite. Weitere Seiten sind verfügbar.',
      total:'Alle',open:'Offen',in_progress:'In Arbeit',blocked:'Blockiert',closed:'Abgeschlossen',deferred:'Zurückgestellt',pinned:'Angeheftet',active:'Aktiv',completion:'Fortschritt',all:'Alle',date:'Datum',tasks:'Aufgaben',owner:'Zuständig',type:'Typ',description:'Beschreibung',comments:'Kommentare',dependencies:'Abhängigkeiten',none:'Keine Angaben',unassigned:'Unzugewiesen',changedAt:'Geändert',id:'ID',titleCol:'Titel',status:'Status'
    },
    en: {
      tabToday:'Today',tabProjects:'Projects',tabMetrics:'Metrics',tabRoadmaps:'Roadmaps',tabState:'State',tabRepo:'Repository',refresh:'Refresh',logout:'Sign out',signedIn:'Signed in as',loading:'Loading data …',failed:'Could not load data. Please try again.',login:'Sign in',unauthorized:'Sign in to view private Beads data.',partial:'Not every tracker could be read; totals are incomplete:',stale:'This snapshot is more than 15 minutes old.',updated:'Updated',footer:'Cloudflare is the operational Beads data source.',readonly:'Read-only access · no task changes',close:'Close',
      area:'Area',repository:'Repository',search:'Search',searchWork:'Title, ID or label …',resetFilters:'Reset filters',allAreas:'All areas',allRepos:'All repositories',filterShown:'{n} of {m} open beads',filterSearchNote:'Search narrows lists, not inflow and outflow.',
      todayTitle:'Today · {date}',sumReady:'{n} beads are ready',sumP0:', {n} of them critical (P0)',sumAttention:'. {n} need attention',sumWorking:', {n} are in progress',sumDone:'. Closed today: {n}.',sumNone:'No open work in this selection.',
      kpiOpen:'Open work',kpiOpenSub:'{net} net in 7 days',kpiP0:'Critical (P0)',kpiP0Sub:'plus {n} P1',kpiWorking:'In progress',kpiWorkingSub:'{n} with a live claim',kpiAttention:'Needs attention',kpiAttentionSub:'{n} wait on dependencies',kpiToday:'Closed today',kpiTodaySub:'yesterday {n}',kpiWeek:'Done · 7 days',kpiWeekSub:'{delta} vs previous week',
      focusTitle:'Do next',focusHint:'Ready, unblocked and not in anyone\'s hands: overdue first, then by priority, work it unblocks and age.',attentionTitle:'Needs attention',attentionHint:'Stuck, waiting or waiting for a decision.',workingTitle:'In progress now',workingHint:'Who works on what, and since when.',doneTitle:'Closed',doneSummary:'{done} done and {dropped} dropped in the last 7 days.',showDropped:'Show dropped',showMore:'Show all {n}',showLess:'Show less',
      noFocus:'Nothing is ready right now. Check “Needs attention”.',noAttention:'Nothing is stuck.',noWorking:'Nobody is working on a task right now.',noDone:'Nothing in this selection was closed in the last 7 days.',dropped:'dropped',
      chipOverdue:'overdue',chipDue:'due {when}',chipUnblocks:'unblocks {n}',chipStale:'unchanged for {n} days',chipAge:'open for {n} days',chipUnassigned:'unassigned',
      rsLapsed:'Stalled',rsLapsedDetail:'last changed {when} · {who}',rsBlocked:'Blocked',rsDecision:'Decision needed',rsWaiting:'Waiting',liveClaim:'live claim',noClaim:'no claim',since:'since {when}',updatedWhen:'changed {when}',today:'Today',yesterday:'Yesterday',priority:'Priority',
      projectsTitle:'Projects and milestones',projectsHint:'A milestone is a Beads milestone or an epic with the milestone label; its progress counts the closed beads beneath it. Click a phase to filter the list.',showClosedMilestones:'Show closed',milestones:'Milestones',projectsSummary:'{open} open, {closable} of them with every bead done · {done} closed · {uncovered} open beads hang on no milestone.',msClosable:'all beads done',allPhases:'All phases',noPhase:'No phase',phaseMeta:'{done}/{total} milestones',noMilestones:'No milestones match this selection.',msActive:'active',msPlanned:'planned',msDone:'done',colMilestone:'Milestone',colPhase:'Phase',colState:'State',colProgress:'Progress',colOpenBeads:'Open',blockedShort:'blocked',inProgressShort:'in progress',
      metricsTitle:'Metrics',metricsHint:'Inflow, completion and backlog. Completion measures finished work, not product readiness.',mCreated:'Created',mDone:'Done',mDropped:'Dropped',mNet:'Net backlog',mRate:'Done per day',mAge:'Median open age',mDays:'{n} days',mWindow:'in {n} days',mNetGood:'backlog shrinks',mNetBad:'backlog grows',mAgeSub:'days since creation',
      flowTitle:'Created and done per day',flowHint:'Dropped work does not count as done. Days in UTC.',legendDone:'Done',legendCreated:'Created',table:'Table',flowNote:'Dropped in this window: {n} (not charted).',backlogTitle:'Open beads over time',backlogHint:'Daily measurement of all active beads (epics included), not reconstructed.',backlogFiltered:'This repository has no daily measurement of its own; the history shows the selection without the repository filter.',backlogOpen:'Open',archive:'Dolt archive',archiveNote:'Dolt archive · originally recorded days (Europe/Berlin).',utcDays:'Daily observations in UTC.',noHistory:'No historical observations yet. History grows with daily captures.',current:'current',
      repositories:'Repositories',repoMetricsHint:'Click a row to see that repository\'s work under “Today”. Shared trackers are split by the configured repository label.',colOpen:'Open',colP0:'P0',colP1:'P1',colWorking:'In progress',colAttention:'Attention',colCreated7:'New 7 d',colDone7:'Done 7 d',colNet7:'Net 7 d',sortAscending:'Sort ascending',sortDescending:'Sort descending',noRepos:'No repositories match this selection.',
      roadmaps:'Roadmaps',roadmapHint:'Each repository ROADMAP.md, read live from GitHub and joined with the Beads of each milestone.',fullText:'Full text',milestoneView:'Milestones',onGithub:'Open on GitHub',lastChanged:'last changed',verified:'verified',checklist:'Checklist',beadsProgress:'Beads',openBeads:'Open beads',currentMilestone:'Current',noRoadmap:'This repository has no ROADMAP.md.',noRoadmaps:'No roadmaps are shared.',roadmapUnavailable:'The roadmap could not be read from GitHub. Please try again later.',noRoadmapMilestones:'No vX.Y.Z milestones were found in this roadmap.',epicMissing:'epic missing in Beads',epic:'Epic',extraEpics:'Milestone epics only in Beads',extraEpicsHint:'These milestone epics are not in ROADMAP.md.',noChecklist:'No checklist in this milestone.',blocking:'blocking',moreBeads:'more open beads',trackerUnavailable:'Beads could not be read; progress shows the checklist only.',uncoveredOpen:'open beads hang on no milestone.',markPulled:'↑ pulled forward',markDeferred:'↓ deferred',markAhead:'↑ done ahead',fromVersion:'from',toVersion:'to',markPulledHint:'Pulled forward from a later milestone.',markDeferredHint:'Moved to a later milestone.',markAheadHint:'Done before this milestone is up.',state_done:'done',state_current:'current',state_planned:'planned',state_deferred:'deferred',state_unknown:'no state',phase:'Phase',done:'done',overviewTitle:'Roadmap milestones',overviewHint:'For each repository the active milestone, its steps and what comes next. Click a row to open its roadmap.',sequence:'Sequence',activeMilestone:'Active milestone',activeMilestones:'active milestones',steps:'Steps',nextMilestone:'Next',before:'Before',after:'After',allDone:'All milestones are done.',noRoadmapShort:'no ROADMAP.md',roadmapUnreadable:'roadmap unreadable',noRoadmapMilestonesShort:'no vX.Y.Z milestones',repoCount:'repositories',tasksAndModules:'Tasks & modules',legendDoneMs:'done',legendCurrent:'active',legendPlanned:'planned',legendDeferred:'deferred',openShort:'open',stateCol:'State',
      stateTitle:'Product state',stateHint:'Generated state report from the configured repository: headline numbers, targets, product versions, journeys and beads per store.',stateMissing:'The state page has not been generated yet.',stateGenerated:'generated',stHeadline:'Headline',stMeasures:'Measures of success',stProducts:'Products',stJourneys:'Journeys',stBeads:'Beads per store',stBeadsLive:'Live from the tracker; the page itself reports: ',stCollectors:'Sources',stSignal:'Signal',stNow:'Now',stTrend:'Trend',stSource:'Source',stBaseline:'Baseline',stCurrent:'Current',stTarget:'Target',stProduct:'Product',stStable:'Stable (newest tag)',stLive:'Live',stPreview:'Preview',stPreviewRev:'Preview revision',stJourney:'Journey',stTitle:'Title',stReceipt:'Receipt',stFindings:'Findings',stStore:'Store',stOpen:'Open',stP0:'P0',stP1:'P1',stP0P1:'P0/P1',stBlocked:'Blocked',stDeferred:'Deferred (P0/P1)',stUnmapped:'Outside a milestone (P0/P1)',stNoThread:'Without thread (P0/P1)',stCollector:'Source',stStatus:'Status',stNote:'Note',stNoPreview:'no preview target',
      healthTitle:'Store health',healthHint:'Latest hourly sample of the store; visible to operators only.',healthNone:'No hourly sample is stored yet.',healthSignal:'Signal',healthValue:'Value',healthLimit:'Limit',healthStorage:'Storage',healthGrowth:'Growth per day',healthErrors:'Error rate',healthLatency:'Write latency (max)',healthRows:'Issues · events · comments',healthRequests:'Requests in interval',healthBreached:'threshold breached',healthOk:'within limits',
      scopes:'Scopes',labels:'Labels',types:'Types',searchScopes:'Search scopes …',scopeNote:'Labels or task types across all repositories. A task can carry several labels.',scope:'Scope',noScopes:'No scopes match this selection.',scopesPartial:'Unreadable:',
      modules:'Modules',modulesHint:'Epics with the progress of their subtasks.',repoScopes:'Scopes in this repository',noModules:'No epics in this repository.',unfiled:'No module',truncated:'Very large tracker: not every task was evaluated.',subtasks:'subtasks',history:'Task history',searchTasks:'Search tasks …',more:'Load more',loaded:'tasks loaded',noTasks:'No tasks match this selection.',noPageTasks:'No matches on this page. More pages are available.',
      total:'All',open:'Open',in_progress:'In progress',blocked:'Blocked',closed:'Closed',deferred:'Deferred',pinned:'Pinned',active:'Active',completion:'Progress',all:'All',date:'Date',tasks:'Tasks',owner:'Assignee',type:'Type',description:'Description',comments:'Comments',dependencies:'Dependencies',none:'No information',unassigned:'Unassigned',changedAt:'Changed',id:'ID',titleCol:'Title',status:'Status'
    }
  };
  let language = (navigator.language || 'de').startsWith('en') ? 'en' : 'de';
  try { const saved = localStorage.getItem('beads.dashboard.language'); if (saved === 'de' || saved === 'en') language = saved; } catch {}
  const DAY = 86400000, NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const t = (key) => copy[language][key] ?? key;
  const fmt = (key, vars) => t(key).replace(/\{(\w+)\}/g, (m, k) => vars[k] !== undefined ? String(vars[k]) : m);
  const locale = () => language === 'de' ? 'de-DE' : 'en-GB';
  const num = (n) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(locale()) : '—';
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + num(Math.abs(n));
  const date = (value) => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString(locale(), {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; };
  const clock = (value) => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(locale(), {hour:'2-digit',minute:'2-digit'}) : '—'; };
  const dayLabel = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString(locale(), language === 'de' ? {day:'2-digit',month:'2-digit',timeZone:'UTC'} : {day:'numeric',month:'short',timeZone:'UTC'});
  const localDay = (value) => { const d = new Date(value); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function rel(value) {
    const diff = Date.parse(value) - Date.now(); if (!Number.isFinite(diff)) return '—';
    const units = [['day', DAY], ['hour', 3600000], ['minute', 60000]];
    const [unit, size] = units.find(([, s]) => Math.abs(diff) >= s) || ['minute', 60000];
    return new Intl.RelativeTimeFormat(locale(), {numeric:'auto', style:'short'}).format(Math.round(diff / size), unit);
  }
  const ageDays = (value) => Math.max(0, Math.floor((Date.now() - Date.parse(value)) / DAY));
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const clear = (node) => node.replaceChildren();
  const ICONS = {
    alert:'M12 3.5l9 16H3l9-16zM12 10v4.5M12 17.5v.01', clock:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2', check:'M5 12.5l4.5 4.5L19 7.5',
    lock:'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3', pause:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 9v6M14 9v6', flag:'M5 21V4h11l-2 4 2 4H5',
    arrow:'M5 12h13M13 6l6 6-6 6', calendar:'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', bolt:'M13 3L5 13h6l-1 8 8-10h-6l1-8z',
    play:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 8.5l5 3.5-5 3.5z', stack:'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5', target:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    trend:'M3 17l6-6 4 4 8-8M15 7h6v6', inbox:'M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5'
  };
  function icon(name) { const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS(NS, 'path'); path.setAttribute('d', ICONS[name]); svg.append(path); return svg; }
  function svgEl(tag, attrs, text) { const node = document.createElementNS(NS, tag); Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, String(v))); if (text !== undefined) node.textContent = text; return node; }
  const labelFor = (table, key) => { const v = (snapshot?.labels?.[table] || {})[key]; return typeof v === 'string' ? v : v ? (v[language] || v.en || Object.values(v)[0]) : undefined; };
  const groupName = (g) => labelFor('groups', g) || g;
  const phaseLabel = (c) => { const name = c && labelFor('phases', c); return c ? c + (name ? ' · ' + name : '') : ''; };
  // Phases follow the order their names are configured in (PORTFOLIO_LABELS phases), then natural order; no phase comes last.
  const phaseCompare = (a, b) => { const order = Object.keys(snapshot?.labels?.phases || {}), rank = (p) => !p ? Infinity : order.includes(p) ? order.indexOf(p) : order.length; return (rank(a) - rank(b) || 0) || String(a || '').localeCompare(String(b || ''), 'en', {numeric:true}); };

  let authenticated = false, snapshot, focus, milestoneData, view = 'today';
  let overviewRequest = 0, focusRequest = 0, milestoneRequest = 0;
  const filters = {group:'', repo:'', q:''};
  try { const saved = JSON.parse(localStorage.getItem('beads.dashboard.filters') || '{}'); ['group', 'repo'].forEach(k => { if (typeof saved[k] === 'string') filters[k] = saved[k]; }); } catch {}
  const saveFilters = () => { try { localStorage.setItem('beads.dashboard.filters', JSON.stringify({group:filters.group, repo:filters.repo})); } catch {} };
  const expanded = {focus:false, attention:false, working:false, done:false};
  let windowDays = 30, showDropped = false, showClosedMilestones = false, phaseFilter = null, repoSort = {key:'open', direction:-1};

  async function get(url) { const response = await fetch(url, {cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(60000)}); if (!response.ok) { const err = new Error('request failed'); err.status = response.status; throw err; } return response.json(); }
  function message(node, key) { clear(node); node.append(el('p', t(key), 'empty')); }
  function signedOut() { authenticated = false; $('viewer').hidden = true; $('logout-form').hidden = true; const n = $('notice'); clear(n); n.classList.add('error'); n.append(document.createTextNode(t('unauthorized') + ' ')); const a = el('a', t('login')); a.href = '/dashboard/login'; n.append(a); if (!focus) { ['focus-list', 'attention-list', 'working-list'].forEach(id => { clear($(id)); $(id).append(el('li', t('unauthorized'), 'empty')); }); message($('done-list'), 'unauthorized'); } }
  function error(node, err) { if (err.status === 401) { signedOut(); clear(node); return; } message(node, 'failed'); }

  // ---------- Work model: one lane per open record, computed from the focus projection ----------
  const overdue = (r) => Boolean(r.due_at) && Date.parse(r.due_at) < Date.now();
  const dueSoon = (r) => Boolean(r.due_at) && !overdue(r) && Date.parse(r.due_at) - Date.now() < 3 * DAY;
  // Lapsed claims and in-progress work nobody holds or touched for two days are stuck, not in progress.
  const stalled = (r) => r.lapsed || (r.status === 'in_progress' && !(r.claim && r.claim.live) && Date.now() - Date.parse(r.updated_at) > 2 * DAY);
  function laneOf(r) {
    if (r.container) return 'container';
    if (stalled(r)) return 'attention';
    if (r.status === 'in_progress' || (r.claim && r.claim.live)) return 'working';
    if (r.status === 'blocked' || r.waiting || r.type === 'decision') return 'attention';
    if (r.ready && r.status === 'open') return 'focus';
    if (r.blocked) return 'dependent';
    return 'later';
  }
  function reasonOf(r) {
    if (stalled(r)) return {key:'rsLapsed', tone:'serious', icon:'clock', detail:fmt('rsLapsedDetail', {who:(r.claim && r.claim.thread) || r.assignee || t('unassigned'), when:rel(r.updated_at)})};
    if (r.status === 'blocked') return {key:'rsBlocked', tone:'crit', icon:'lock'};
    if (r.type === 'decision') return {key:'rsDecision', tone:'info', icon:'flag'};
    return {key:'rsWaiting', tone:'warn', icon:'pause', detail:r.waiting};
  }
  const reasonRank = (r) => stalled(r) ? 0 : r.status === 'blocked' ? 1 : r.type === 'decision' ? 2 : 3;
  function matches(r) {
    if (filters.group && r.group !== filters.group) return false;
    if (filters.repo && r.repo !== filters.repo) return false;
    if (filters.q) { const hay = (r.id + ' ' + r.title + ' ' + r.repo + ' ' + (r.labels || []).join(' ') + ' ' + (r.assignee || '')).toLocaleLowerCase(); if (!hay.includes(filters.q.toLocaleLowerCase())) return false; }
    return true;
  }
  const flowMatches = (f) => (!filters.group || (focus.repositories[f.repo] ?? '') === filters.group) && (!filters.repo || f.repo === filters.repo);
  function lanes() {
    const out = {focus:[], attention:[], working:[], dependent:[], later:[], container:[], all:[]};
    if (!focus) return out;
    for (const r of focus.open) if (matches(r)) { const lane = laneOf(r); out[lane].push(r); if (lane !== 'container') out.all.push(r); }
    out.focus.sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || a.priority - b.priority || Number(dueSoon(b)) - Number(dueSoon(a)) || b.blocks - a.blocks || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    out.attention.sort((a, b) => a.priority - b.priority || reasonRank(a) - reasonRank(b) || a.updated_at.localeCompare(b.updated_at));
    out.working.sort((a, b) => a.priority - b.priority || String(b.updated_at).localeCompare(String(a.updated_at)));
    return out;
  }
  function utcDays(count) { const end = Date.parse(focus.generated_at.slice(0, 10) + 'T00:00:00Z'); return Array.from({length:count}, (_, i) => new Date(end - (count - 1 - i) * DAY).toISOString().slice(0, 10)); }
  function flowSeries(count) {
    const days = utcDays(count), index = new Map(days.map((d, i) => [d, i])), rows = days.map(d => ({date:d, created:0, done:0, dropped:0}));
    for (const f of focus.flow) { const i = index.get(f.date); if (i === undefined || !flowMatches(f)) continue; rows[i].created += f.created; rows[i].done += f.done; rows[i].dropped += f.dropped; }
    return rows;
  }
  const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);

  // ---------- Shared pieces ----------
  function prioBadge(p) { const b = el('span', 'P' + p, 'prio p' + p); b.title = t('priority') + ' P' + p; return b; }
  function chip(text, tone, iconName) { const c = el('span', undefined, 'chip' + (tone ? ' ' + tone : '')); if (iconName) c.append(icon(iconName)); c.append(document.createTextNode(text)); return c; }
  function titleButton(r) { const b = el('button', r.title, 'work-title'); b.type = 'button'; b.addEventListener('click', () => openIssue(r, r.catalog)); return b; }
  function meta(r, extra) {
    const m = el('div', undefined, 'work-meta'); m.append(el('span', r.repo, 'repo'), el('code', r.id));
    if (r.type && r.type !== 'task') m.append(el('span', r.type));
    (extra || []).forEach(x => m.append(x)); return m;
  }
  function workItem(r, options) {
    const li = el('li', undefined, 'work'), body = el('div');
    li.append(prioBadge(r.priority));
    if (options.reason) { const reason = reasonOf(r), line = el('div', undefined, 'reason ' + reason.tone); line.append(icon(reason.icon), document.createTextNode(t(reason.key) + (reason.detail && reason.key === 'rsWaiting' ? ' · ' + reason.detail : ''))); body.append(line); }
    body.append(titleButton(r));
    const extra = [];
    if (options.working) {
      const who = (r.claim && r.claim.thread) || r.assignee, since = (r.claim && r.claim.since) || r.updated_at, live = Boolean(r.claim && r.claim.live);
      const holder = el('span'); holder.append(el('span', undefined, 'live' + (live ? '' : ' off')), document.createTextNode(' ' + (who || t('unassigned')) + ' · ' + fmt('since', {when:rel(since)})));
      holder.style.display = 'inline-flex'; holder.style.alignItems = 'center'; holder.style.gap = '6px'; holder.firstChild.style.marginTop = '0'; holder.title = live ? t('liveClaim') : t('noClaim'); extra.push(holder);
    } else if (options.reason && stalled(r)) extra.push(el('span', reasonOf(r).detail));
    else extra.push(el('span', fmt('updatedWhen', {when:rel(r.updated_at)})));
    body.append(meta(r, extra));
    const chips = el('div', undefined, 'chips');
    if (overdue(r)) chips.append(chip(t('chipOverdue'), 'crit', 'calendar')); else if (dueSoon(r)) chips.append(chip(fmt('chipDue', {when:rel(r.due_at)}), 'warn', 'calendar'));
    if (r.blocks) chips.append(chip(fmt('chipUnblocks', {n:num(r.blocks)}), 'info', 'arrow'));
    if (r.stale && !options.working) chips.append(chip(fmt('chipStale', {n:num(ageDays(r.updated_at))}), '', 'clock'));
    else if (options.focus && ageDays(r.created_at) >= 30) chips.append(chip(fmt('chipAge', {n:num(ageDays(r.created_at))}), '', 'clock'));
    if (chips.childNodes.length) body.append(chips);
    li.append(body); return li;
  }
  function renderList(listId, moreId, rows, key, emptyKey, limit, options) {
    const list = $(listId), more = $(moreId); clear(list);
    if (!rows.length) { list.append(el('li', t(emptyKey), 'empty')); more.hidden = true; return; }
    const shown = expanded[key] ? rows.slice(0, 200) : rows.slice(0, limit);
    shown.forEach(r => list.append(workItem(r, options)));
    more.hidden = rows.length <= limit; more.textContent = expanded[key] ? t('showLess') : fmt('showMore', {n:num(rows.length)});
  }
  function niceMax(v) { if (v <= 4) return Math.max(1, Math.ceil(v)); const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  const compact = (n) => n >= 10000 ? (n / 1000).toLocaleString(locale(), {maximumFractionDigits:0}) + 'K' : n >= 1000 ? (n / 1000).toLocaleString(locale(), {maximumFractionDigits:1}) + 'K' : num(n);
  function kpi(label, value, sub, options) {
    const card = el('div', undefined, 'kpi' + (options && options.tone ? ' ' + options.tone : ''));
    const head = el('div', undefined, 'kpi-label'); if (options && options.icon) head.append(icon(options.icon)); head.append(document.createTextNode(label));
    card.append(head, el('div', value, 'kpi-value'));
    const s = el('div', undefined, 'kpi-sub'); if (sub instanceof Node) s.append(sub); else if (sub) s.textContent = sub; card.append(s);
    if (options && options.spark) card.append(options.spark);
    return card;
  }
  function deltaNode(text, good) { const d = el('span', text, 'delta' + (good === true ? ' good' : good === false ? ' bad' : '')); return d; }
  function sparkline(values) {
    const max = Math.max(1, ...values), w = values.length * 10, svg = svgEl('svg', {viewBox:'0 0 ' + w + ' 28', preserveAspectRatio:'none', class:'spark', 'aria-hidden':'true'});
    values.forEach((v, i) => { const h = v ? Math.max(2, v / max * 26) : 1; svg.append(svgEl('rect', {x:i * 10 + 1.5, y:28 - h, width:7, height:h, rx:1.5, fill:i === values.length - 1 ? 'var(--series-1)' : 'var(--axis)'})); });
    return svg;
  }

  // ---------- Today ----------
  function renderToday() {
    const day = new Date().toLocaleDateString(locale(), {weekday:'long', day:'numeric', month:'long'});
    $('today-title').textContent = fmt('todayTitle', {date:day});
    const kpis = $('today-kpis');
    if (!focus) { clear(kpis); ['focus-list', 'attention-list', 'working-list'].forEach(id => { clear($(id)); $(id).append(el('li', t('loading'), 'empty')); }); message($('done-list'), 'loading'); return; }
    const L = lanes(), all = L.all, flow = flowSeries(14), week = flow.slice(7), prev = flow.slice(0, 7);
    const today = localDay(Date.now()), yesterday = localDay(Date.now() - DAY);
    const recent = focus.recent.filter(matches), doneToday = recent.filter(r => r.outcome === 'done' && localDay(r.closed_at) === today).length, doneYesterday = recent.filter(r => r.outcome === 'done' && localDay(r.closed_at) === yesterday).length;
    const p0 = all.filter(r => r.priority === 0).length, p1 = all.filter(r => r.priority === 1).length;
    const net = sum(week, 'created') - sum(week, 'done') - sum(week, 'dropped'), done7 = sum(week, 'done'), donePrev = sum(prev, 'done');
    clear(kpis);
    kpis.append(
      kpi(t('kpiOpen'), compact(all.length), deltaNode(fmt('kpiOpenSub', {net:signed(net)}), net < 0 ? true : net > 0 ? false : undefined), {icon:'inbox'}),
      kpi(t('kpiP0'), num(p0), fmt('kpiP0Sub', {n:num(p1)}), {icon:'alert', tone:p0 ? 'crit' : ''}),
      kpi(t('kpiWorking'), num(L.working.length), fmt('kpiWorkingSub', {n:num(L.working.filter(r => r.claim && r.claim.live).length)}), {icon:'play'}),
      kpi(t('kpiAttention'), num(L.attention.length), fmt('kpiAttentionSub', {n:num(L.dependent.length)}), {icon:'pause', tone:L.attention.length ? 'serious' : ''}),
      kpi(t('kpiToday'), num(doneToday), fmt('kpiTodaySub', {n:num(doneYesterday)}), {icon:'check', tone:'good'}),
      kpi(t('kpiWeek'), num(done7), deltaNode(fmt('kpiWeekSub', {delta:signed(done7 - donePrev)}), done7 > donePrev ? true : done7 < donePrev ? false : undefined), {icon:'trend', spark:sparkline(flow.map(f => f.done))}));
    const parts = all.length ? [fmt('sumReady', {n:num(L.focus.length)}), L.focus.some(r => r.priority === 0) ? fmt('sumP0', {n:num(L.focus.filter(r => r.priority === 0).length)}) : '', fmt('sumAttention', {n:num(L.attention.length)}), fmt('sumWorking', {n:num(L.working.length)}), fmt('sumDone', {n:num(doneToday)})] : [t('sumNone')];
    $('today-summary').textContent = parts.join('');
    $('focus-count').textContent = num(L.focus.length); $('attention-count').textContent = num(L.attention.length); $('working-count').textContent = num(L.working.length);
    renderList('focus-list', 'focus-more', L.focus, 'focus', 'noFocus', 8, {focus:true});
    renderList('attention-list', 'attention-more', L.attention, 'attention', 'noAttention', 6, {reason:true});
    renderList('working-list', 'working-more', L.working, 'working', 'noWorking', 6, {working:true});
    renderDone(recent);
  }
  function renderDone(recent) {
    const root = $('done-list'), more = $('done-more'); clear(root);
    const done = recent.filter(r => r.outcome === 'done').length, dropped = recent.length - done;
    $('done-summary').textContent = fmt('doneSummary', {done:num(done), dropped:num(dropped)}); $('done-count').textContent = num(done);
    const rows = recent.filter(r => showDropped || r.outcome === 'done');
    if (!rows.length) { message(root, 'noDone'); more.hidden = true; return; }
    const shown = expanded.done ? rows.slice(0, 300) : rows.slice(0, 12);
    const today = localDay(Date.now()), yesterday = localDay(Date.now() - DAY), groups = new Map();
    shown.forEach(r => { const d = localDay(r.closed_at); (groups.get(d) || groups.set(d, []).get(d)).push(r); });
    groups.forEach((items, d) => {
      const group = el('div', undefined, 'day-group'), head = el('div', undefined, 'day-head');
      const name = d === today ? t('today') : d === yesterday ? t('yesterday') : new Date(d + 'T12:00:00').toLocaleDateString(locale(), {weekday:'long', day:'numeric', month:'long'});
      head.append(el('span', name), el('span', num(rows.filter(r => localDay(r.closed_at) === d).length))); group.append(head);
      const list = el('ul', undefined, 'done-list');
      items.forEach(r => { const li = el('li', undefined, 'done-item' + (r.outcome === 'dropped' ? ' dropped' : '')), body = el('div', undefined, 'done-body'); li.append(icon(r.outcome === 'dropped' ? 'pause' : 'check')); body.append(titleButton(r)); const extra = [el('span', clock(r.closed_at))]; if (r.outcome === 'dropped') extra.push(el('span', t('dropped'))); const m = meta(r, extra); m.prepend(prioBadge(r.priority)); body.append(m); li.append(body); list.append(li); });
      group.append(list); root.append(group);
    });
    more.hidden = rows.length <= 12; more.textContent = expanded.done ? t('showLess') : fmt('showMore', {n:num(rows.length)});
  }

  // ---------- Projects ----------
  async function loadMilestones(fresh) {
    const request = ++milestoneRequest; if (!milestoneData) message($('milestone-list'), 'loading');
    try { const data = await get('/dashboard/api/milestones' + (fresh ? '?fresh=true' : '')); if (request !== milestoneRequest) return; milestoneData = data; renderProjects(); }
    catch (err) { if (request === milestoneRequest) error($('milestone-list'), err); }
  }
  const msKind = (m) => m.status === 'closed' ? 'done' : m.counts.total > 0 && m.counts.active === 0 ? 'closable' : m.status === 'in_progress' || m.counts.closed > 0 || m.counts.in_progress > 0 ? 'active' : 'planned';
  const MS_ORDER = {closable:0, active:1, planned:2, done:3};
  function milestoneRows() {
    // The focus report names the owning repository of every container, closed ones included.
    const owners = (focus && focus.containers) || {};
    const rows = [];
    for (const repo of (milestoneData && milestoneData.repositories) || []) for (const m of repo.milestones) {
      const own = owners[m.id], row = {...m, repo:own || repo.name, group:own ? focus.repositories[own] ?? repo.group : repo.group, catalog:repo.id, labels:[]};
      if (matches(row)) rows.push(row);
    }
    return rows;
  }
  function renderProjects() {
    const list = $('milestone-list'), phases = $('phase-list');
    if (!milestoneData) return;
    const all = milestoneRows(), keys = [...new Set(all.map(m => m.central || ''))].sort(phaseCompare);
    // Without any phase label there is nothing to pick between, so the tiles stay hidden.
    clear(phases); phases.hidden = keys.length === 1 && !keys[0];
    keys.forEach(key => {
      const items = all.filter(m => (m.central || '') === key), total = items.reduce((n, m) => n + m.counts.total, 0), closed = items.reduce((n, m) => n + m.counts.closed, 0), done = items.filter(m => m.status === 'closed').length;
      const card = el('button', undefined, 'phase'); card.type = 'button'; card.setAttribute('aria-pressed', String(phaseFilter === key));
      const name = key ? labelFor('phases', key) : ''; card.append(el('span', key || t('noPhase'), 'phase-key'), el('span', name || key || t('noPhase'), 'phase-name'));
      const meter = el('div', undefined, 'meter' + (total && closed === total ? ' done' : '')), fill = el('i'); fill.style.width = (total ? Math.round(closed / total * 100) : 0) + '%'; meter.append(fill);
      const m = el('div', undefined, 'phase-meta'); m.append(el('span', fmt('phaseMeta', {done:num(done), total:num(items.length)})), el('span', (total ? Math.round(closed / total * 100) : 0) + ' %'));
      card.append(meter, m); card.title = num(closed) + '/' + num(total) + ' Beads';
      card.addEventListener('click', () => { phaseFilter = phaseFilter === key ? null : key; renderProjects(); });
      phases.append(card);
    });
    const shown = all.filter(m => (phaseFilter === null || (m.central || '') === phaseFilter) && (showClosedMilestones || m.status !== 'closed'))
      .sort((a, b) => phaseCompare(a.central, b.central) || (MS_ORDER[msKind(a)] - MS_ORDER[msKind(b)]) || String(a.version).localeCompare(String(b.version), undefined, {numeric:true}) || a.title.localeCompare(b.title));
    const uncovered = ((milestoneData && milestoneData.repositories) || []).filter(r => !filters.group || r.group === filters.group).reduce((n, r) => n + (r.uncovered || 0), 0);
    $('projects-summary').textContent = fmt('projectsSummary', {open:num(all.filter(m => m.status !== 'closed').length), closable:num(all.filter(m => msKind(m) === 'closable').length), done:num(all.filter(m => m.status === 'closed').length), uncovered:num(uncovered)});
    $('milestones-count').textContent = num(shown.length);
    clear(list);
    if (!shown.length) { message(list, 'noMilestones'); return; }
    const {table:tbl, body} = table(['colMilestone', 'colPhase', 'colState', 'colProgress', 'colOpenBeads']); tbl.className = 'ms-table';
    tbl.tHead.rows[0].cells[4].className = 'num';
    shown.forEach(m => {
      const row = el('tr', undefined, 'clickable'), cell = el('td', undefined, 'ms-cell'), name = el('button', undefined, 'work-title');
      name.type = 'button'; if (m.version) name.append(el('span', 'v' + m.version, 'vers')); name.append(document.createTextNode(m.name)); name.addEventListener('click', (e) => { e.stopPropagation(); openIssue({id:m.id, title:m.title}, m.catalog); });
      cell.append(name, el('span', m.repo + ' · ' + m.id, 'sub'));
      const kind = msKind(m), state = el('span', undefined, 'ms-state ' + kind); state.append(el('i', undefined, 'dot'), document.createTextNode(t({done:'msDone', closable:'msClosable', active:'msActive', planned:'msPlanned'}[kind])));
      const progress = el('div', undefined, 'ms-progress'), meter = el('div', undefined, 'meter' + (kind === 'done' || kind === 'closable' ? ' done' : '')), fill = el('i'); fill.style.width = m.counts.completion + '%'; meter.append(fill);
      progress.append(meter, el('span', num(m.counts.closed) + '/' + num(m.counts.total) + ' · ' + m.counts.completion + ' %'));
      const open = el('td', num(m.counts.active), 'num'); const extra = [m.counts.in_progress ? num(m.counts.in_progress) + ' ' + t('inProgressShort') : '', m.counts.blocked ? num(m.counts.blocked) + ' ' + t('blockedShort') : ''].filter(Boolean).join(' · ');
      if (extra) open.append(el('span', extra, 'sub' + (m.counts.blocked ? ' danger-text' : '')));
      const phaseCell = el('td', m.central || '—'); if (m.central && labelFor('phases', m.central)) phaseCell.append(el('span', labelFor('phases', m.central), 'sub'));
      const stateCell = el('td'); stateCell.append(state); const progressCell = el('td'); progressCell.append(progress);
      row.append(cell, phaseCell, stateCell, progressCell, open);
      row.addEventListener('click', () => openIssue({id:m.id, title:m.title}, m.catalog)); body.append(row);
    });
    list.append(tbl);
  }

  // ---------- Metrics ----------
  let flowDays = [], historyRows = [];
  function renderMetrics() {
    if (!focus) { message($('flow-chart'), 'loading'); return; }
    const flow = flowSeries(windowDays), all = lanes().all;
    const created = sum(flow, 'created'), done = sum(flow, 'done'), dropped = sum(flow, 'dropped'), net = created - done - dropped;
    const last7 = flowSeries(7), rate = sum(last7, 'done') / 7;
    const ages = all.map(r => ageDays(r.created_at)).sort((a, b) => a - b), median = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
    const k = $('metrics-kpis'); clear(k);
    k.append(kpi(t('mCreated'), compact(created), fmt('mWindow', {n:windowDays}), {icon:'inbox'}), kpi(t('mDone'), compact(done), fmt('mWindow', {n:windowDays}), {icon:'check', tone:'good'}),
      kpi(t('mDropped'), compact(dropped), fmt('mWindow', {n:windowDays}), {icon:'pause'}),
      kpi(t('mNet'), signed(net), deltaNode(net > 0 ? t('mNetBad') : t('mNetGood'), net <= 0), {icon:'stack', tone:net > 0 ? 'serious' : 'good'}),
      kpi(t('mRate'), rate.toLocaleString(locale(), {maximumFractionDigits:1}), fmt('mWindow', {n:7}), {icon:'trend', spark:sparkline(flowSeries(14).map(f => f.done))}),
      kpi(t('mAge'), fmt('mDays', {n:num(median)}), t('mAgeSub'), {icon:'clock'}));
    flowDays = flow; drawFlow();
    $('flow-note').textContent = fmt('flowNote', {n:num(dropped)}) + (filters.q ? ' ' + t('filterSearchNote') : '');
    const tableRoot = $('flow-table'); clear(tableRoot); const {table:tbl, body} = table(['date', 'legendCreated', 'legendDone', 'mDropped']); tbl.className = 'compact';
    [...flow].reverse().forEach(f => { const row = el('tr'); row.append(el('td', dayLabel(f.date)), el('td', num(f.created), 'num'), el('td', num(f.done), 'num'), el('td', num(f.dropped), 'num')); body.append(row); });
    [1, 2, 3].forEach(i => tbl.tHead.rows[0].cells[i].className = 'num'); tableRoot.append(tbl);
    renderBacklog(); renderRepoMetrics(); renderScopes();
  }
  function chartFrame(root, height) { clear(root); const width = Math.max(280, Math.round(root.clientWidth || root.parentElement.clientWidth || 600)); return {width, height, svg:svgEl('svg', {viewBox:'0 0 ' + width + ' ' + height, width, height, class:'chart', role:'img', tabindex:'0'})}; }
  function yAxis(svg, max, y, left, right) { const ticks = max % 2 === 0 || max > 4 ? [0, max / 2, max] : [0, max]; ticks.forEach(v => { const yy = y(v); svg.append(svgEl('line', {x1:left, x2:right, y1:yy, y2:yy, class:v ? 'gridline' : 'baseline'}), svgEl('text', {x:left - 8, y:yy + 4, 'text-anchor':'end'}, compact(v))); }); }
  function attachHover(root, svg, count, xOf, show) {
    const tip = el('div', undefined, 'tooltip'); tip.hidden = true; root.append(tip); let current = -1;
    const cross = svgEl('line', {class:'cross', y1:0, y2:0, x1:0, x2:0, visibility:'hidden'}); svg.append(cross);
    const move = (i) => { if (i < 0 || i >= count) return; current = i; const pos = show(i, tip); cross.setAttribute('x1', xOf(i)); cross.setAttribute('x2', xOf(i)); cross.setAttribute('y1', pos.top); cross.setAttribute('y2', pos.bottom); cross.setAttribute('visibility', 'visible'); tip.hidden = false; tip.style.left = Math.min(Math.max(xOf(i), 80), (root.clientWidth || 600) - 80) + 'px'; tip.style.top = (pos.anchor - 8) + 'px'; };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', (e) => { const box = svg.getBoundingClientRect(), x = (e.clientX - box.left) * (svg.viewBox.baseVal.width / box.width); let best = 0, gap = Infinity; for (let i = 0; i < count; i++) { const d = Math.abs(xOf(i) - x); if (d < gap) { gap = d; best = i; } } move(best); });
    svg.addEventListener('pointerleave', hide); svg.addEventListener('blur', hide); svg.addEventListener('focus', () => move(current < 0 ? count - 1 : current));
    svg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { move(Math.max(0, current - 1)); e.preventDefault(); } else if (e.key === 'ArrowRight') { move(Math.min(count - 1, current + 1)); e.preventDefault(); } else if (e.key === 'Escape') hide(); });
  }
  function tipRows(tip, title, rows) { clear(tip); tip.append(el('strong', title)); rows.forEach(([cls, label, value]) => { const row = el('div', undefined, 'row'), name = el('span'); name.append(el('i', undefined, 'key ' + cls), document.createTextNode(label)); row.append(name, el('b', num(value))); tip.append(row); }); }
  function drawFlow() {
    const root = $('flow-chart'), days = flowDays; if (!days.length) return;
    const {width, height, svg} = chartFrame(root, 230), L = 44, R = 10, T = 12, B = 26, iw = width - L - R, ih = height - T - B;
    const max = niceMax(Math.max(1, ...days.map(d => Math.max(d.done, d.created)))), y = (v) => T + ih - v / max * ih, slot = iw / days.length, bw = Math.max(2, Math.min(24, slot * 0.62)), x = (i) => L + slot * i + slot / 2;
    svg.setAttribute('aria-label', t('flowTitle')); yAxis(svg, max, y, L, width - R);
    days.forEach((d, i) => { const h = y(0) - y(d.done); if (h <= 0) return; const r = Math.min(4, h, bw / 2), x0 = x(i) - bw / 2, top = y(d.done);
      svg.append(svgEl('path', {class:'s1', d:'M' + x0 + ',' + y(0) + 'V' + (top + r) + 'Q' + x0 + ',' + top + ' ' + (x0 + r) + ',' + top + 'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ',' + top + ' ' + (x0 + bw) + ',' + (top + r) + 'V' + y(0) + 'Z', 'data-i':i})); });
    svg.append(svgEl('polyline', {class:'s2', points:days.map((d, i) => x(i) + ',' + y(d.created)).join(' ')}));
    const last = days.length - 1; svg.append(svgEl('circle', {class:'s2dot', cx:x(last), cy:y(days[last].created), r:4}));
    const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(iw / 70)));
    days.forEach((d, i) => { if (i % labelEvery === 0 || i === last) svg.append(svgEl('text', {x:x(i), y:height - 6, 'text-anchor':i === 0 ? 'start' : i === last ? 'end' : 'middle'}, dayLabel(d.date))); });
    root.append(svg);
    attachHover(root, svg, days.length, x, (i, tip) => { svg.querySelectorAll('.s1').forEach(p => p.classList.toggle('hover', p.getAttribute('data-i') === String(i))); tipRows(tip, dayLabel(days[i].date), [['box s1', t('legendDone'), days[i].done], ['s2', t('legendCreated'), days[i].created]]); return {top:T, bottom:y(0), anchor:Math.min(y(days[i].done), y(days[i].created))}; });
  }
  let historySource = 'cloudflare';
  function historyPoints() {
    const points = (historySource === 'dolt' ? snapshot.archive?.points || [] : snapshot.history || []).slice();
    const observed = new Date(snapshot.generatedAt);
    if (historySource === 'cloudflare' && Number.isFinite(observed.getTime())) { const today = observed.toISOString().slice(0, 10); if (!points.some(p => p.date === today)) points.push({date:today, generatedAt:snapshot.generatedAt, totals:snapshot.totals, repositories:snapshot.repositories, current:true}); }
    return points.sort((a, b) => a.date.localeCompare(b.date));
  }
  function renderBacklog() {
    if (!snapshot) return;
    const select = $('history-source'), had = select.value; clear(select); const live = el('option', 'Cloudflare'); live.value = 'cloudflare'; select.append(live);
    if (snapshot.archive && snapshot.archive.points.length) { const a = el('option', t('archive')); a.value = 'dolt'; select.append(a); } else historySource = 'cloudflare';
    select.value = historySource || had; select.hidden = select.options.length < 2;
    // A per-repository series exists only for catalog repositories; repositories named by a label fall back to the area.
    const catalogRepo = filters.repo && (snapshot.repositories || []).some(r => r.name === filters.repo);
    const pick = (repos) => repos.filter(r => !r.error && (filters.repo && catalogRepo ? r.name === filters.repo : !filters.group || r.group === filters.group));
    const all = historyPoints(), lastDate = all.length ? Date.parse(all[all.length - 1].date) : Date.now(), cutoff = lastDate - (Math.max(windowDays, 14) - 1) * DAY;
    historyRows = all.filter(p => Date.parse(p.date) >= cutoff).map(p => ({date:p.date, current:p.current, value:pick(p.repositories || []).reduce((n, r) => n + (Number(r.counts.active) || 0), 0)}));
    $('backlog-note').textContent = [historySource === 'dolt' ? t('archiveNote') : t('utcDays'), filters.repo && !catalogRepo ? t('backlogFiltered') : ''].filter(Boolean).join(' ');
    drawBacklog();
    const tableRoot = $('backlog-table'); clear(tableRoot); const {table:tbl, body} = table(['date', 'backlogOpen']); tbl.className = 'compact'; tbl.tHead.rows[0].cells[1].className = 'num';
    [...historyRows].reverse().forEach(p => { const row = el('tr'); row.append(el('td', dayLabel(p.date) + (p.current ? ' · ' + t('current') : '')), el('td', num(p.value), 'num')); body.append(row); }); tableRoot.append(tbl);
  }
  function drawBacklog() {
    const root = $('backlog-chart'), rows = historyRows; if (!rows.length) { message(root, 'noHistory'); return; }
    const {width, height, svg} = chartFrame(root, 230), L = 44, R = 46, T = 12, B = 26, iw = width - L - R, ih = height - T - B;
    const max = niceMax(Math.max(1, ...rows.map(r => r.value))), y = (v) => T + ih - v / max * ih, x = (i) => L + (rows.length === 1 ? iw / 2 : iw * i / (rows.length - 1));
    svg.setAttribute('aria-label', t('backlogTitle')); yAxis(svg, max, y, L, width - R);
    const line = rows.map((r, i) => x(i) + ',' + y(r.value)).join(' ');
    svg.append(svgEl('polygon', {class:'s1area', points:x(0) + ',' + y(0) + ' ' + line + ' ' + x(rows.length - 1) + ',' + y(0)}), svgEl('polyline', {class:'s1line', points:line}));
    const last = rows.length - 1; svg.append(svgEl('circle', {class:'s1dot', cx:x(last), cy:y(rows[last].value), r:4}), svgEl('text', {x:x(last) + 8, y:y(rows[last].value) + 4, style:'fill:var(--ink);font-weight:600'}, compact(rows[last].value)));
    const labelEvery = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 70)));
    rows.forEach((r, i) => { if (i % labelEvery === 0 || i === last) svg.append(svgEl('text', {x:x(i), y:height - 6, 'text-anchor':i === 0 ? 'start' : i === last ? 'end' : 'middle'}, dayLabel(r.date))); });
    root.append(svg);
    attachHover(root, svg, rows.length, x, (i, tip) => { tipRows(tip, dayLabel(rows[i].date), [['s1', t('backlogOpen'), rows[i].value]]); return {top:T, bottom:y(0), anchor:y(rows[i].value)}; });
  }
  const repoColumns = [['repo', 'repository'], ['open', 'colOpen'], ['p0', 'colP0'], ['p1', 'colP1'], ['working', 'colWorking'], ['attention', 'colAttention'], ['created7', 'colCreated7'], ['done7', 'colDone7'], ['net7', 'colNet7']];
  function renderRepoMetrics() {
    const root = $('repo-metrics'); clear(root); if (!focus) return;
    const rows = new Map(), week = new Set(utcDays(7));
    const rowFor = (repo) => rows.get(repo) || rows.set(repo, {repo, group:focus.repositories[repo] ?? '', open:0, p0:0, p1:0, working:0, attention:0, created7:0, done7:0, net7:0}).get(repo);
    for (const r of focus.open) { if (r.container || (filters.group && r.group !== filters.group)) continue; const lane = laneOf(r), row = rowFor(r.repo); row.open++; if (r.priority === 0) row.p0++; if (r.priority === 1) row.p1++; if (lane === 'working') row.working++; if (lane === 'attention') row.attention++; }
    for (const f of focus.flow) { if (!week.has(f.date) || (filters.group && (focus.repositories[f.repo] ?? '') !== filters.group)) continue; const row = rowFor(f.repo); row.created7 += f.created; row.done7 += f.done; row.net7 += f.created - f.done - f.dropped; }
    const list = [...rows.values()].sort((a, b) => { const av = a[repoSort.key], bv = b[repoSort.key]; return (typeof av === 'string' ? av.localeCompare(bv, locale()) : av - bv) * repoSort.direction || a.repo.localeCompare(b.repo); });
    $('repo-metrics-count').textContent = num(list.length);
    if (!list.length) { message(root, 'noRepos'); return; }
    const max = Math.max(1, ...list.map(r => r.open)), tbl = el('table'), head = el('thead'), tr = el('tr'), body = el('tbody'); tbl.className = 'compact';
    repoColumns.forEach(([key, label]) => { const th = el('th'); th.scope = 'col'; if (key !== 'repo') th.className = 'num'; const b = el('button', undefined, 'column-sort'); b.type = 'button'; const active = repoSort.key === key; b.append(el('span', t(label)), el('span', active ? repoSort.direction === 1 ? '↑' : '↓' : '', 'sort-indicator')); th.setAttribute('aria-sort', active ? repoSort.direction === 1 ? 'ascending' : 'descending' : 'none'); b.setAttribute('aria-label', t(label) + ' · ' + t(active && repoSort.direction === -1 ? 'sortAscending' : 'sortDescending')); b.addEventListener('click', () => { repoSort = {key, direction:repoSort.key === key ? -repoSort.direction : key === 'repo' ? 1 : -1}; renderRepoMetrics(); }); th.append(b); tr.append(th); });
    head.append(tr); tbl.append(head, body);
    list.forEach(r => {
      const row = el('tr', undefined, 'clickable'), name = el('td'); name.append(el('strong', r.repo), el('span', r.group ? groupName(r.group) : '—', 'sub'));
      const open = el('td', undefined, 'num'), cell = el('div', undefined, 'bar-cell'), meter = el('div', undefined, 'meter'), fill = el('i'); fill.style.width = Math.round(r.open / max * 100) + '%'; meter.append(fill); cell.append(meter, el('span', num(r.open))); open.append(cell);
      row.append(name, open, el('td', num(r.p0), 'num' + (r.p0 ? ' danger-text' : '')), el('td', num(r.p1), 'num'), el('td', num(r.working), 'num'), el('td', num(r.attention), 'num'), el('td', num(r.created7), 'num'), el('td', num(r.done7), 'num'), el('td', signed(r.net7), 'num'));
      row.addEventListener('click', () => { filters.repo = r.repo; filters.group = ''; saveFilters(); renderFilters(); location.hash = '#today'; }); body.append(row);
    });
    root.append(tbl);
  }

  // ---------- Filters, header and data loading ----------
  function renderFilters() {
    const groups = new Set([...(snapshot?.repositories || []).map(r => r.group), ...Object.values(focus?.repositories || {})].filter(Boolean));
    const g = $('filter-group'); clear(g); const allG = el('option', t('allAreas')); allG.value = ''; g.append(allG);
    [...groups].sort((a, b) => groupName(a).localeCompare(groupName(b), locale())).forEach(key => { const o = el('option', groupName(key)); o.value = key; g.append(o); });
    if (filters.group && focus && !groups.has(filters.group)) filters.group = '';
    g.value = filters.group;
    const repos = Object.entries(focus?.repositories || {}).filter(([, group]) => !filters.group || group === filters.group).map(([name]) => name).sort((a, b) => a.localeCompare(b, locale()));
    const r = $('filter-repo'); clear(r); const allR = el('option', t('allRepos')); allR.value = ''; r.append(allR); repos.forEach(name => { const o = el('option', name); o.value = name; r.append(o); });
    if (filters.repo && focus && !repos.includes(filters.repo)) filters.repo = '';
    r.value = filters.repo; const search = $('filter-search'); if (document.activeElement !== search && search.value.trim() !== filters.q) search.value = filters.q;
    const active = filters.group || filters.repo || filters.q; $('filter-reset').hidden = !active;
    $('filter-summary').textContent = focus && active ? fmt('filterShown', {n:num(lanes().all.length), m:num(focus.open.filter(x => !x.container).length)}) : '';
  }
  function renderNotice() {
    const n = $('notice'); if (!authenticated) return; clear(n); const notes = [];
    const missing = (focus?.stores || []).filter(s => s.kind !== 'ok').map(s => s.repository);
    if (missing.length || snapshot?.source?.partial) notes.push(t('partial') + ' ' + (missing.length ? missing.join(', ') : ''));
    const generated = focus?.generated_at || snapshot?.generatedAt, age = Date.now() - Date.parse(generated);
    if (generated && (!Number.isFinite(age) || age > 15 * 60000)) notes.push(t('stale'));
    n.classList.toggle('error', notes.length > 0); n.textContent = notes.join(' ');
  }
  function renderHeader() {
    $('logout-form').hidden = !authenticated; $('viewer').hidden = !authenticated || !snapshot?.viewer?.email;
    $('viewer').textContent = authenticated && snapshot?.viewer?.email ? snapshot.viewer.email : ''; $('viewer').title = t('signedIn') + ' ' + ($('viewer').textContent || '');
    $('dashboard-name').textContent = snapshot?.title || '';
    const generated = focus?.generated_at || snapshot?.generatedAt; $('freshness').textContent = generated ? t('updated') + ' ' + clock(generated) : '';
  }
  function renderAll() { renderHeader(); renderNotice(); renderFilters(); if (view === 'today') renderToday(); if (view === 'projects') renderProjects(); if (view === 'metrics') renderMetrics(); }
  async function loadOverview() {
    const request = ++overviewRequest;
    try { const data = await get('/dashboard/api/overview'); if (request !== overviewRequest) return; authenticated = true; snapshot = data; renderAll(); if (view === 'roadmaps') renderOverview(); }
    catch (err) { if (request === overviewRequest) { if (err.status === 401) signedOut(); else { $('notice').classList.add('error'); $('notice').textContent = t('failed'); } } }
  }
  async function loadFocus(fresh) {
    const request = ++focusRequest; if (focus) $('main').classList.add('loading');
    try { const data = await get('/dashboard/api/focus' + (fresh ? '?fresh=true' : '')); if (request !== focusRequest) return; authenticated = true; focus = data; renderAll(); }
    catch (err) { if (request !== focusRequest) return; if (err.status === 401) signedOut(); else if (!focus) { ['focus-list', 'attention-list', 'working-list'].forEach(id => { clear($(id)); $(id).append(el('li', t('failed'), 'empty')); }); message($('done-list'), 'failed'); } }
    finally { if (request === focusRequest) $('main').classList.remove('loading'); }
  }
  async function refresh() {
    const button = $('refresh'); button.disabled = true;
    const work = [loadOverview(), loadFocus(true)];
    if (milestoneData) work.push(loadMilestones(true)); if (stateData) work.push(loadState(true)); if (roadmapRound) work.push(loadRoadmaps(view === 'repo' ? roadmapRepo : undefined)); if (healthData) work.push(loadHealth()); if (scopeData) work.push(loadScopes());
    await Promise.allSettled(work); button.disabled = false;
  }

  // ---------- Roadmaps (ported) ----------
  function table(headers) { const table = el('table'), thead = el('thead'), tr = el('tr'); headers.forEach(h => { const th = el('th', t(h)); th.scope = 'col'; tr.append(th); }); thead.append(tr); table.append(thead); const body = el('tbody'); table.append(body); return {table, body}; }
  function bar(pct) { const wrap = el('div', undefined, 'progress'), b = el('span', undefined, 'bar'), fill = el('i'); const v = Math.max(0, Math.min(100, Number(pct) || 0)); fill.style.width = v + '%'; b.append(fill); wrap.append(b, el('span', num(v) + ' %')); return wrap; }
  let roadmapList = [], roadmapData, roadmapFull = false, roadmapRepo, overviewGroup = '', overviewPhase = '', roadmapRound = 0;
  let stateData, stateRequest = 0;
  const roadmapCache = new Map(), roadmapPending = new Map();
  const finished = (m) => m.stateKind === 'done' || Boolean(m.beads && m.beads.status === 'closed') || (m.stateKind !== 'current' && m.checklist.total > 0 && m.checklist.done === m.checklist.total);
  const kindOf = (m) => m.current ? 'current' : finished(m) ? 'done' : m.stateKind === 'deferred' ? 'deferred' : 'planned';
  const stepPct = (m) => m.checklist.total ? Math.round(100 * m.checklist.done / m.checklist.total) : finished(m) ? 100 : 0;
  const msLabel = (m) => 'v' + m.version + ' · ' + m.name;
  function partition(data) { const list = data.milestones || [], index = list.findIndex(m => m.current); if (index < 0) return {before:list.filter(finished), current:null, after:list.filter(m => !finished(m))}; return {before:list.slice(0, index), current:list[index], after:list.slice(index + 1)}; }
  function fetchRoadmapData(id, fresh = false) {
    if (!fresh && roadmapCache.has(id)) return Promise.resolve(roadmapCache.get(id));
    if (!fresh && roadmapPending.has(id)) return roadmapPending.get(id);
    const request = get('/dashboard/api/roadmaps/' + encodeURIComponent(id) + (fresh ? '?fresh=true' : '')).then(data => { roadmapCache.set(id, data); return data; }, err => { if (err.status === 401) throw err; const data = {id, loadError:err.status === 503 ? 'unavailable' : 'failed'}; roadmapCache.set(id, data); return data; }).finally(() => roadmapPending.delete(id));
    roadmapPending.set(id, request); return request;
  }
  async function loadRoadmaps(freshId) {
    const round = ++roadmapRound; roadmapCache.clear();
    if (!roadmapList.length) message($('roadmap-overview'), 'loading');
    try { const data = await get('/dashboard/api/roadmaps'); if (round !== roadmapRound) return; roadmapList = data.repositories || []; }
    catch (err) { if (round === roadmapRound) { error($('roadmap-overview'), err); error($('repo-body'), err); } return; }
    const select = $('repo-select'); clear(select); roadmapList.forEach(r => { const o = el('option', r.name); o.value = r.id; select.append(o); });
    if (view === 'repo') renderRepoView(); renderOverview();
    // The shown repository loads first; the rest follow with bounded concurrency and fill the overview as they arrive.
    const ids = roadmapList.map(r => r.id).sort((a, b) => Number(b === roadmapRepo) - Number(a === roadmapRepo)); let cursor = 0;
    await Promise.all(Array.from({length:Math.min(4, ids.length)}, async () => { while (cursor < ids.length && round === roadmapRound) { const id = ids[cursor++]; try { await fetchRoadmapData(id, id === freshId); } catch (err) { if (round === roadmapRound) error($('roadmap-overview'), err); return; } if (round !== roadmapRound) return; renderOverview(); if (view === 'repo' && roadmapRepo === id) renderRepoView(); } }));
  }
  function summarize(data) { const {before, current, after} = partition(data), list = data.milestones || []; const next = after.find(m => !finished(m) && kindOf(m) !== 'deferred') || after[0] || null; const open = current && current.beads ? current.beads.openTotal : 0, blocking = current && current.beads ? current.beads.open.filter(b => b.blocking).length : 0; return {list, before, current, after, next, done:list.filter(finished).length, open, blocking}; }
  function strip(list) { const node = el('span', undefined, list.length > 30 ? 'strip dense' : 'strip'); node.setAttribute('aria-hidden', 'true'); list.forEach(m => { const seg = el('i', undefined, kindOf(m)); seg.title = msLabel(m) + ' · ' + t('state_' + kindOf(m)); node.append(seg); }); return node; }
  function mini(done, total, pct) { const wrap = el('div', undefined, 'mini'), b = el('span', undefined, 'bar'), fill = el('i'); fill.style.width = Math.max(0, Math.min(100, pct)) + '%'; b.append(fill); wrap.append(b, el('span', num(done) + '/' + num(total))); return wrap; }
  function pills(root, options, selected, onPick) { clear(root); options.forEach(([value, label, count]) => { const b = el('button', undefined, 'pill'); b.type = 'button'; b.setAttribute('aria-pressed', String(value === selected)); b.append(el('span', label)); if (count !== undefined) b.append(el('span', num(count), 'count')); b.addEventListener('click', () => onPick(value)); root.append(b); }); }
  function renderOverview() {
    const root = $('roadmap-overview'); if (!roadmapList.length) return;
    const rows = roadmapList.map(r => { const data = roadmapCache.get(r.id); return {r, data, info:data && !data.loadError && !data.missing ? summarize(data) : null}; });
    const groups = [...new Set(roadmapList.map(r => r.group).filter(Boolean))].sort((a, b) => groupName(a).localeCompare(groupName(b), locale()));
    pills($('overview-groups'), [['', t('allAreas'), roadmapList.length]].concat(groups.map(g => [g, groupName(g), roadmapList.filter(r => r.group === g).length])), overviewGroup, (g) => { overviewGroup = g; renderOverview(); });
    const phases = [...new Set(rows.map(x => x.info && x.info.current && x.info.current.central).filter(Boolean))].sort(phaseCompare);
    pills($('overview-phases'), [['', t('allPhases')]].concat(phases.map(p => [p, phaseLabel(p), rows.filter(x => x.info && x.info.current && x.info.current.central === p).length])), overviewPhase, (p) => { overviewPhase = p; renderOverview(); });
    const shown = rows.filter(x => (!overviewGroup || x.r.group === overviewGroup) && (!overviewPhase || (x.info && x.info.current && x.info.current.central === overviewPhase)));
    const rank = (x) => !x.data ? 3 : x.info ? (x.info.current ? 0 : 1) : 2;
    shown.sort((a, b) => rank(a) - rank(b) || (a.info && b.info ? phaseCompare(a.info.current && a.info.current.central, b.info.current && b.info.current.central) : 0) || a.r.name.localeCompare(b.r.name, locale()));
    const loaded = rows.filter(x => x.data).length, active = shown.filter(x => x.info && x.info.current).length, blocking = shown.reduce((n, x) => n + (x.info ? x.info.blocking : 0), 0);
    $('overview-summary').textContent = [num(shown.length) + ' ' + t('repoCount'), num(active) + ' ' + t('activeMilestones'), blocking ? num(blocking) + ' ' + t('blocking') : '', loaded < rows.length ? t('loading') + ' ' + num(loaded) + '/' + num(rows.length) : ''].filter(Boolean).join(' · ');
    const {table:tbl, body} = table(['repository', 'sequence', 'activeMilestone', 'steps', 'openBeads', 'nextMilestone']); tbl.className = 'compact overview';
    shown.forEach(({r, data, info}) => {
      const row = el('tr', undefined, 'clickable'), name = el('td'), link = el('a', r.name); link.href = '#repo=' + encodeURIComponent(r.id); name.append(link, el('span', groupName(r.group), 'sub')); row.append(name);
      row.addEventListener('click', (event) => { if (event.target.closest('a')) return; location.hash = '#repo=' + encodeURIComponent(r.id); });
      if (!info) { const cell = el('td', !data ? t('loading') : data.missing ? t('noRoadmapShort') : t('roadmapUnreadable'), 'sub' + (data && data.loadError ? ' danger-text' : '')); cell.colSpan = 5; row.append(cell); body.append(row); return; }
      const seq = el('td'); seq.append(strip(info.list), el('span', num(info.done) + '/' + num(info.list.length) + ' ' + t('done'), 'sub')); row.append(seq);
      const cur = el('td', undefined, 'wrap'), c = info.current;
      if (c) { const title = el('span', undefined, 'ms-name'); title.append(el('span', 'v' + c.version, 'vers'), document.createTextNode(c.name)); cur.append(title); if (c.central) cur.append(el('span', phaseLabel(c.central), 'sub')); }
      else cur.append(el('span', info.list.length ? t('allDone') : t('noRoadmapMilestonesShort'), 'sub'));
      row.append(cur);
      const steps = el('td'); if (c) steps.append(mini(c.checklist.done, c.checklist.total, stepPct(c))); else steps.append(el('span', '—', 'sub')); row.append(steps);
      const open = el('td'); open.append(el('span', c && c.beads ? num(info.open) : '—')); if (info.blocking) open.append(el('span', num(info.blocking) + ' ' + t('blocking'), 'sub danger-text')); row.append(open);
      const nx = el('td', undefined, 'wrap'); if (info.next) { const title = el('span'); title.append(el('span', 'v' + info.next.version, 'vers'), document.createTextNode(info.next.name)); nx.append(title); } else nx.append(el('span', '—', 'sub')); row.append(nx);
      body.append(row);
    });
    clear(root); if (!shown.length) { message(root, 'noMilestones'); return; } root.append(tbl);
  }
  function beadsTable(beads, repoId) {
    const {table:tbl, body} = table(['id', 'titleCol', 'status', 'priority', 'type']); tbl.className = 'compact';
    beads.forEach(b => { const row = el('tr', undefined, 'clickable'), idCell = el('td'), open = el('button', b.id, 'link-button'); open.type = 'button'; open.addEventListener('click', () => openIssue(b, repoId)); idCell.append(open);
      const title = el('td', b.title, 'wrap'); if (b.blocking) { title.append(document.createTextNode(' ')); title.append(el('span', t('blocking'), 'badge blocked')); }
      row.append(idCell, title, el('td', t(b.status)), el('td', 'P' + b.priority), el('td', b.type)); row.addEventListener('click', (event) => { if (!event.target.closest('button')) openIssue(b, repoId); }); body.append(row); });
    const wrap = el('div', undefined, 'table-wrap'); wrap.append(tbl); return wrap;
  }
  function checklistOf(m) { const root = el('div'); if (!m.items.length) { root.append(el('p', t('noChecklist'), 'sub')); return root; } let group, ul; m.items.forEach(item => { if (!ul || item.group !== group) { group = item.group; if (group) root.append(el('div', group, 'rm-group')); ul = el('ul', undefined, 'checklist'); root.append(ul); } const li = checkItem(item.done, item.text, item.marker); li.style.marginLeft = (Math.min(item.depth, 4) * 20) + 'px'; ul.append(li); }); return root; }
  function milestoneBody(m, data) {
    const root = el('div', undefined, 'ms-body'), info = el('p', undefined, 'sub'), epicId = (m.beads && m.beads.epic) || m.epic;
    const parts = [m.state ? t('stateCol') + ': ' + m.state : '', m.central ? t('phase') + ' ' + phaseLabel(m.central) : ''].filter(Boolean);
    if (parts.length) info.append(document.createTextNode(parts.join(' · ')));
    if (epicId) { info.append(document.createTextNode((parts.length ? ' · ' : '') + t('epic') + ' ')); if (m.beads && m.beads.status) { const b = el('button', epicId, 'link-button'); b.type = 'button'; b.addEventListener('click', () => openIssue({id:epicId, title:msLabel(m)}, data.catalogId)); info.append(b); } else info.append(el('code', epicId)); }
    if (m.beads && m.beads.epicMissing) info.append(el('span', ' · ' + t('epicMissing'), 'danger-text'));
    if (info.childNodes.length) root.append(info);
    const bars = el('div', undefined, 'rm-bars'), c1 = el('div'); c1.append(el('span', t('checklist') + ' · ' + num(m.checklist.done) + '/' + num(m.checklist.total), 'sub'), bar(stepPct(m))); bars.append(c1);
    if (m.beads) { const c2 = el('div'); c2.append(el('span', t('beadsProgress') + ' · ' + num(m.beads.counts.closed) + '/' + num(m.beads.counts.total) + (m.beads.counts.blocked ? ' · ' + num(m.beads.counts.blocked) + ' ' + t('blocked') : ''), 'sub'), bar(m.beads.counts.completion)); bars.append(c2); }
    root.append(bars, checklistOf(m));
    if (m.beads && m.beads.openTotal) { root.append(el('div', t('openBeads') + ' · ' + num(m.beads.openTotal), 'rm-group'), beadsTable(m.beads.open, data.catalogId)); if (m.beads.openTotal > m.beads.open.length) root.append(el('p', '+ ' + num(m.beads.openTotal - m.beads.open.length) + ' ' + t('moreBeads'), 'sub')); }
    return root;
  }
  function milestoneRow(m, data) {
    const kind = kindOf(m), row = el('details', undefined, 'ms-row ' + kind), summary = el('summary'); row.id = 'ms-' + m.version;
    const title = el('span', undefined, 'ms-title'); title.append(el('span', undefined, 'chev'), el('span', undefined, 'dot ' + kind), el('span', 'v' + m.version, 'vers'), el('span', m.name, 'ms-name'));
    const ahead = m.items.filter(i => i.marker && (i.marker.kind === 'ahead' || i.marker.kind === 'pulled')).length, moved = m.items.filter(i => i.marker && i.marker.kind === 'deferred').length;
    const badges = el('span', undefined, 'ms-badges'); if (kind !== 'planned') badges.append(el('span', t('state_' + kind), 'badge' + (kind === 'deferred' ? ' blocked' : '')));
    if (ahead) badges.append(el('span', num(ahead) + ' ' + t('markAhead'), 'marker ahead')); if (moved) badges.append(el('span', num(moved) + ' ' + t('markDeferred'), 'marker deferred'));
    const open = m.beads && m.beads.openTotal ? el('span', num(m.beads.openTotal) + ' ' + t('openShort'), 'sub ms-open') : el('span', '', 'ms-open');
    summary.append(title, badges, mini(m.checklist.done, m.checklist.total, stepPct(m)), open); row.append(summary);
    row.addEventListener('toggle', () => { if (row.open && row.childNodes.length === 1) row.append(milestoneBody(m, data)); });
    return row;
  }
  function renderRepoView() {
    const root = $('repo-body'), meta = $('repo-meta'); clear(meta); $('roadmap-link').hidden = true;
    $('roadmap-mode').textContent = t(roadmapFull ? 'milestoneView' : 'fullText'); $('roadmap-mode').setAttribute('aria-pressed', String(roadmapFull));
    const source = roadmapList.find(r => r.id === roadmapRepo) || (!roadmapRepo && roadmapList[0]);
    if (!source) { $('repo-name').textContent = t('tabRepo'); return message(root, roadmapRound ? 'noRoadmaps' : 'loading'); }
    roadmapRepo = source.id; $('repo-name').textContent = source.name; $('repo-select').value = source.id;
    const data = roadmapCache.get(source.id); roadmapData = data;
    if (!data) { message(root, 'loading'); fetchRoadmapData(source.id).then(() => { if (roadmapRepo === source.id && view === 'repo') renderRepoView(); renderOverview(); }, err => error(root, err)); return; }
    clear(root);
    if (data.loadError) return message(root, data.loadError === 'unavailable' ? 'roadmapUnavailable' : 'failed');
    if (data.missing) return message(root, 'noRoadmap');
    $('roadmap-link').hidden = !data.url; if (data.url) $('roadmap-link').href = data.url;
    meta.textContent = [groupName(data.group), data.lastChanged ? t('lastChanged') + ' ' + date(data.lastChanged) : '', data.lastVerified ? t('verified') + ' ' + data.lastVerified : '', t('updated') + ' ' + date(data.fetchedAt)].filter(Boolean).join(' · ');
    const notes = []; if (data.error) notes.push(t('trackerUnavailable')); if (data.truncated) notes.push(t('truncated')); if (data.uncovered) notes.push(num(data.uncovered) + ' ' + t('uncoveredOpen'));
    if (notes.length) root.append(el('p', notes.join(' '), 'notice error'));
    if (roadmapFull) { root.append(renderMarkdown(data.markdown)); return; }
    const list = data.milestones || []; if (!list.length) return root.append(el('p', t('noRoadmapMilestones'), 'empty'));
    const sequence = el('ol', undefined, 'sequence'); sequence.setAttribute('aria-label', t('sequence'));
    list.forEach(m => { const item = el('li', undefined, kindOf(m)), link = el('a', 'v' + m.version); link.href = '#ms-' + m.version; link.title = m.name + ' · ' + t('state_' + kindOf(m));
      link.addEventListener('click', (event) => { event.preventDefault(); const target = document.getElementById('ms-' + m.version); if (!target) return; if (target.tagName === 'DETAILS') target.open = true; const group = target.closest('details.ms-group'); if (group) group.open = true; target.scrollIntoView({behavior:'smooth', block:'start'}); });
      item.append(link); sequence.append(item); });
    root.append(sequence);
    const {before, current, after} = partition(data);
    if (before.length) { const group = el('details', undefined, 'ms-group'), summary = el('summary', undefined, 'section-label'); summary.append(el('span', undefined, 'chev'), document.createTextNode(' ' + t('before') + ' · ' + num(before.filter(finished).length) + '/' + num(before.length) + ' ' + t('done'))); group.append(summary); const rows = el('div', undefined, 'ms-list'); before.forEach(m => rows.append(milestoneRow(m, data))); group.append(rows); root.append(group); }
    root.append(el('div', t('activeMilestone'), 'section-label'));
    const active = el('section', undefined, 'ms-active');
    if (current) { active.id = 'ms-' + current.version; const head = el('div', undefined, 'module-head'), title = el('h3'); title.append(el('span', 'v' + current.version, 'vers'), document.createTextNode(current.name)); const badges = el('span', undefined, 'detail-labels'); badges.append(el('span', t('currentMilestone'), 'badge current-badge')); head.append(title, badges); active.append(head, milestoneBody(current, data)); }
    else active.append(el('p', t('allDone'), 'empty'));
    root.append(active);
    if (after.length) { root.append(el('div', t('after') + ' · ' + num(after.length), 'section-label')); const rows = el('div', undefined, 'ms-list'); after.forEach(m => rows.append(milestoneRow(m, data))); root.append(rows); }
    if ((data.extraEpics || []).length) { root.append(el('div', t('extraEpics'), 'section-label'), el('p', t('extraEpicsHint'), 'sub')); root.append(beadsTable(data.extraEpics.map(e => ({id:e.id, title:e.title, status:e.status, priority:'–', type:'epic', blocking:false})), data.catalogId)); }
  }

  // ---------- State page (ported) ----------
  async function loadState(fresh) {
    const request = ++stateRequest; if (!stateData && view === 'state') message($('state-body'), 'loading');
    try { const data = await get('/dashboard/api/state' + (fresh ? '?fresh=true' : '')); if (request !== stateRequest) return; stateData = data; $('tab-state').hidden = false; if (view === 'state') renderState(); }
    catch (err) { if (request !== stateRequest) return; if (err.status === 404) { $('tab-state').hidden = true; if (view === 'state') location.replace('#today'); return; } if (view === 'state') error($('state-body'), err); }
  }
  function stateTable(headers, rows) {
    const {table:tbl, body} = table(headers); tbl.className = 'compact';
    rows.forEach(cells => { const row = el('tr'); cells.forEach((v, i) => { const td = el('td'); if (v && typeof v === 'object' && v.strong) td.append(el('strong', v.strong)); else inline(v === null || v === undefined ? '—' : String(v), td); if (i === 0 || i === 2) td.className = 'wrap'; row.append(td); }); body.append(row); });
    const wrap = el('div', undefined, 'table-wrap'); wrap.append(tbl); return wrap;
  }
  function stateBlock(root, titleKey, content, hint) { root.append(el('h3', t(titleKey), 'block')); if (hint) root.append(el('p', hint, 'sub')); root.append(content); }
  function renderState() {
    const root = $('state-body'); clear(root); const data = stateData || {};
    const link = $('state-link'); link.hidden = !(data.source && data.source.markdownUrl); if (!link.hidden) link.href = data.source.markdownUrl;
    if (data.missing || !data.page) { $('state-meta').textContent = t('stateHint'); message(root, 'stateMissing'); return; }
    const page = data.page, run = page.run || {}, d = page.collectors_data || {};
    $('state-meta').textContent = page.date + ' · ' + t('stateGenerated') + ' ' + date(page.generated_at) + (run.host ? ' · ' + run.host : '') + (run.workspace_revision ? ' · ' + String(run.workspace_revision).slice(0, 9) : '');
    stateBlock(root, 'stHeadline', stateTable(['stSignal', 'stNow', 'stTrend', 'stSource'], (page.headline || []).map(r => [r.label, r.display, r.trend, r.source])));
    stateBlock(root, 'stMeasures', stateTable(['stSignal', 'stBaseline', 'stCurrent', 'stTarget', 'stTrend'], (page.measures || []).map(r => [r.signal, r.baseline, r.display, r.target, r.trend])));
    if (d.products && d.products.status === 'ok') stateBlock(root, 'stProducts', stateTable(['stProduct', 'repository', 'stStable', 'stLive', 'stPreview', 'stPreviewRev'], d.products.data.map(p => [
      p.core ? {strong:p.id} : p.id, p.repository, p.stable.tag || '—',
      p.live ? (p.live.version ? p.live.version + (p.live.revision ? ' @ ' + String(p.live.revision).slice(0, 9) : '') : 'n/a (' + p.live.error + ')') : '—',
      p.preview.version || '—', p.preview.target ? (p.preview.revision ? String(p.preview.revision).slice(0, 9) : 'n/a (' + p.preview.error + ')') : t('stNoPreview')])));
    if (d.journeys && d.journeys.status === 'ok') { const j = d.journeys.data; stateBlock(root, 'stJourneys', stateTable(['stJourney', 'stTitle', 'stReceipt', 'stFindings'], j.rows.map(r => [r.id, r.title, r.receipt, (r.findings || []).join(', ') || '—'])), (j.candidate_id || 'no candidate') + ' · ' + (j.status || '—') + ' · ' + j.verified + ' / ' + j.total + (j.revision ? ' · ' + String(j.revision).slice(0, 9) : '')); }
    const beads = d.beads;
    if (beads && beads.status === 'ok') {
      const b = beads.data, pair = (n, m) => num(n) + ' (' + num(m) + ')';
      stateBlock(root, 'stBeads', stateTable(['stStore', 'stOpen', 'stP0', 'stP1', 'stBlocked', 'stDeferred', 'stUnmapped', 'stNoThread'], b.stores.filter(s => !s.error).map(s => [s.store, num(s.open_class), num(s.p0), num(s.p1), num(s.blocked), pair(s.deferred, s.deferred_p0p1), pair(s.unmapped, s.unmapped_p0p1), pair(s.without_thread, s.without_thread_p0p1)])
        .concat([[{strong:'total'}, num(b.totals.open_class), num(b.totals.p0), num(b.totals.p1), num(b.totals.blocked), pair(b.totals.deferred, b.totals.deferred_p0p1), pair(b.totals.unmapped, b.totals.unmapped_p0p1), pair(b.totals.without_thread, b.totals.without_thread_p0p1)]])), b.note);
    } else if (snapshot && snapshot.repositories) {
      const repos = snapshot.repositories.filter(r => !r.error).slice().sort((a, b) => (b.counts.p0p1 - a.counts.p0p1) || a.name.localeCompare(b.name));
      stateBlock(root, 'stBeads', stateTable(['stStore', 'stOpen', 'stP0P1', 'stBlocked', 'deferred'], repos.map(r => [r.name, num(r.counts.active), num(r.counts.p0p1), num(r.counts.blocked), num(r.counts.deferred)])), t('stBeadsLive') + (beads ? beads.reason || beads.status : '—'));
    }
    stateBlock(root, 'stCollectors', stateTable(['stCollector', 'stStatus', 'stNote'], (page.collectors || []).map(c => [c.id, c.status, c.reason || ''])));
  }

  // ---------- Markdown (ported) ----------
  const INLINE = /(\x60+)([\s\S]*?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/;
  function safeHref(href) { try { const base = roadmapData && roadmapData.url || location.href; const url = new URL(href, base); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; } }
  function inline(text, parent) {
    let s = String(text);
    while (s) {
      const m = INLINE.exec(s); if (!m) { parent.append(document.createTextNode(s)); break; }
      if (m.index) parent.append(document.createTextNode(s.slice(0, m.index)));
      if (m[1]) parent.append(el('code', m[2].trim()));
      else if (m[3] || m[4]) { const b = el('strong'); inline(m[3] || m[4], b); parent.append(b); }
      else if (m[5]) { const i = el('em'); inline(m[5], i); parent.append(i); }
      else { const label = m[6] || m[8], url = safeHref(m[7] || m[8]); if (url) { const a = el('a'); inline(label, a); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); } else parent.append(document.createTextNode(label)); }
      s = s.slice(m.index + m[0].length);
    }
    return parent;
  }
  function markerOf(text) {
    let m = /\b(?:pulled forward|pulled ahead|vorgezogen)\b(?:\s+(?:from|aus|von)\s+v?(\d+\.\d+\.\d+))?/i.exec(text);
    if (m) return {kind:'pulled', target:m[1]};
    m = /\b(?:deferred|postponed|moved|verschoben|zurückgestellt)\b(?:\s+(?:to|into|nach|auf|in)\s+v?(\d+\.\d+\.\d+))?/i.exec(text);
    return m && (m[1] || !/^moved/i.test(m[0])) ? {kind:'deferred', target:m[1]} : null;
  }
  function markerBadge(marker) {
    const label = marker.kind === 'ahead' ? t('markAhead') : marker.kind === 'pulled' ? t('markPulled') + (marker.target ? ' ' + t('fromVersion') + ' v' + marker.target : '') : t('markDeferred') + (marker.target ? ' ' + t('toVersion') + ' v' + marker.target : '');
    const badge = el('span', label, 'marker ' + marker.kind); badge.title = t(marker.kind === 'ahead' ? 'markAheadHint' : marker.kind === 'pulled' ? 'markPulledHint' : 'markDeferredHint'); return badge;
  }
  function checkItem(done, text, marker) { const li = el('li', undefined, done ? 'done' : ''), box = el('input'); box.type = 'checkbox'; box.disabled = true; box.checked = done; box.setAttribute('aria-label', t(done ? 'closed' : 'open')); li.append(box, inline(text, el('span', undefined, 'text'))); if (marker) li.append(markerBadge(marker)); return li; }
  function renderMarkdown(markdown) {
    const root = el('div', undefined, 'markdown'), lines = String(markdown).replace(/\r\n?/g, '\n').split('\n'); let i = 0;
    if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) i = end + 1; }
    const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l), isTable = (n) => /^\s*\|/.test(lines[n] || '') && /^\s*\|?\s*:?-{2,}/.test(lines[n + 1] || '');
    const fence = /^\s*(\x60{3,}|~{3,})/, heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/, rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
    const startsBlock = (n) => fence.test(lines[n]) || heading.test(lines[n]) || rule.test(lines[n]) || isList(lines[n]) || isTable(n) || /^\s*>/.test(lines[n]) || /^\s*<!--/.test(lines[n]);
    const split = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    while (i < lines.length) {
      const line = lines[i]; let m;
      if (!line.trim()) { i++; continue; }
      if ((m = fence.exec(line))) { const buf = []; i++; while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]); i++; const pre = el('pre'); pre.append(el('code', buf.join('\n'))); root.append(pre); continue; }
      if (/^\s*<!--/.test(line)) { while (i < lines.length && !lines[i].includes('-->')) i++; i++; continue; }
      if ((m = heading.exec(line))) { root.append(inline(m[2], el('h' + Math.min(6, m[1].length + 2)))); i++; continue; }
      if (rule.test(line)) { root.append(el('hr')); i++; continue; }
      if (isTable(i)) { const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]); const wrap = el('div', undefined, 'table-wrap'), tbl = el('table'), thead = el('thead'), head = el('tr'), body = el('tbody'); split(rows[0]).forEach(c => { const th = el('th'); th.scope = 'col'; head.append(inline(c, th)); }); thead.append(head); rows.slice(2).forEach(r => { const tr = el('tr'); split(r).forEach(c => tr.append(inline(c, el('td')))); body.append(tr); }); tbl.append(thead, body); wrap.append(tbl); root.append(wrap); continue; }
      if (/^\s*>/.test(line)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); const quote = el('blockquote'); quote.append(...renderMarkdown(buf.join('\n')).childNodes); root.append(quote); continue; }
      if (isList(line)) {
        const stack = [];
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) { if (isList(lines[i + 1] || '') || /^\s{2,}\S/.test(lines[i + 1] || '')) { i++; continue; } break; }
          const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
          if (item) {
            const indent = item[1].replace(/\t/g, '  ').length, ordered = /\d/.test(item[2]);
            while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
            let top = stack[stack.length - 1];
            if (!top || indent > top.indent) { const list = el(ordered ? 'ol' : 'ul'); if (top && top.list.lastElementChild) top.list.lastElementChild.append(list); else root.append(list); top = {indent, list}; stack.push(top); }
            const task = /^\[( |x|X)\]\s+(.*)$/.exec(item[3]);
            if (task) { const li = checkItem(task[1] !== ' ', task[2], markerOf(task[2])); li.classList.add('task-item'); top.list.append(li); }
            else top.list.append(inline(item[3], el('li')));
          } else if (stack.length && /^\s+\S/.test(l)) { const last = stack[stack.length - 1].list.lastElementChild; if (last) inline(' ' + l.trim(), last.querySelector('.text') || last); }
          else break;
          i++;
        }
        continue;
      }
      const buf = []; while (i < lines.length && lines[i].trim() && !(buf.length && startsBlock(i))) buf.push(lines[i++].trim());
      root.append(inline(buf.join(' '), el('p')));
    }
    return root;
  }

  // ---------- Health and scopes (ported) ----------
  const mib = (b) => Number.isFinite(Number(b)) ? (Number(b) / 1048576).toLocaleString(locale(), {maximumFractionDigits:1}) + ' MiB' : '—';
  const pct = (r) => Number.isFinite(Number(r)) ? (Number(r) * 100).toLocaleString(locale(), {maximumFractionDigits:2}) + ' %' : '—';
  let healthData, scopeData, scopeRequest = 0;
  async function loadHealth() { try { healthData = await get('/dashboard/api/health'); $('health-section').hidden = false; renderHealth(); } catch { healthData = undefined; $('health-section').hidden = true; } }
  function renderHealth() {
    if (!healthData) return; const root = $('health-body'); clear(root); const s = healthData.sample, lim = healthData.thresholds || {}, hit = new Set(healthData.breached || []);
    $('health-meta').textContent = t('healthHint') + (s ? ' · ' + date(s.at) : '');
    if (!s) { message(root, 'healthNone'); return; }
    const state = (k) => hit.has(k) ? {strong:t('healthBreached')} : t('healthOk');
    root.append(stateTable(['healthSignal', 'healthValue', 'healthLimit', 'status'], [
      [t('healthStorage'), mib(s.storage_bytes), mib(lim.storage_bytes), state('storage_bytes')],
      [t('healthGrowth'), healthData.growth_bytes_per_day === null || healthData.growth_bytes_per_day === undefined ? '—' : mib(healthData.growth_bytes_per_day), mib(lim.storage_growth_bytes_per_day), state('storage_growth')],
      [t('healthErrors'), pct(s.error_rate) + ' · ' + num(s.errors) + '/' + num(s.requests), pct(lim.error_rate), state('error_rate')],
      [t('healthLatency'), num(s.write_latency_ms && s.write_latency_ms.max) + ' ms', num(lim.write_latency_ms) + ' ms', state('write_latency_ms')],
      [t('healthRows'), [s.rows?.issues, s.rows?.events, s.rows?.comments].map(num).join(' · '), '—', '—']]));
  }
  async function loadScopes() { const request = ++scopeRequest; if (!scopeData) message($('scopes'), 'loading'); try { const data = await get('/dashboard/api/scopes'); if (request !== scopeRequest) return; scopeData = data; renderScopes(); } catch (err) { if (request === scopeRequest) error($('scopes'), err); } }
  function renderScopes() {
    if (!scopeData || !snapshot) return; const root = $('scopes'); clear(root);
    const query = $('scope-search').value.toLocaleLowerCase(), kind = $('scope-kind').value;
    const ids = new Set((snapshot.repositories || []).filter(r => !filters.group || r.group === filters.group).map(r => r.id)), names = new Map((snapshot.repositories || []).map(r => [r.id, r.name]));
    const rows = (scopeData[kind] || []).map(s => { const repos = Object.entries(s.repositories || {}).filter(([id]) => ids.has(id)); return {key:s.key, repos, total:repos.reduce((n, [, v]) => n + v.total, 0), closed:repos.reduce((n, [, v]) => n + v.closed, 0)}; }).filter(s => s.total && s.key.toLocaleLowerCase().includes(query)).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)).slice(0, 60);
    if ((scopeData.unavailable || []).length) root.append(el('p', t('scopesPartial') + ' ' + scopeData.unavailable.map(id => names.get(id) || id).join(', '), 'notice error'));
    if (!rows.length) return root.append(el('p', t('noScopes'), 'empty'));
    const {table:tbl, body} = table(['scope', 'total', 'active', 'closed', 'completion']); tbl.className = 'compact';
    rows.forEach(s => { const row = el('tr'); row.append(el('td', s.key), el('td', num(s.total), 'num'), el('td', num(s.total - s.closed), 'num'), el('td', num(s.closed), 'num')); const p = el('td'); p.append(bar(s.total ? Math.round(100 * s.closed / s.total) : 0)); row.append(p); body.append(row); });
    [1, 2, 3].forEach(i => tbl.tHead.rows[0].cells[i].className = 'num'); root.append(tbl);
  }

  // ---------- Repository and issue dialogs (ported) ----------
  let selectedRepo, taskPage, taskRequest = 0, issueRequest = 0, moduleRequest = 0, searchTimer;
  function renderRepoHistory() {
    const root = $('repository-history-table'); clear(root); if (!snapshot || !selectedRepo) return;
    const {table:tbl, body} = table(['date', 'total', 'open', 'in_progress', 'blocked', 'closed']); tbl.className = 'compact';
    const points = historyPoints().map(p => ({point:p, repo:(p.repositories || []).find(r => r.id === selectedRepo.id)})).filter(p => p.repo);
    points.reverse().slice(0, 90).forEach(({point, repo}) => { const row = el('tr'); row.append(el('td', point.date + (point.current ? ' · ' + t('current') : ''))); ['total', 'open', 'in_progress', 'blocked', 'closed'].forEach(k => row.append(el('td', num(repo.counts[k]), 'num'))); body.append(row); });
    if (!points.length) message(root, 'noHistory'); else root.append(tbl);
  }
  async function loadModules(repo) { const request = ++moduleRequest; message($('modules'), 'loading'); clear($('repo-scopes')); try { const data = await get('/dashboard/api/repositories/' + encodeURIComponent(repo.id) + '/modules'); if (request !== moduleRequest || selectedRepo !== repo) return; renderModules(data); } catch (err) { if (request === moduleRequest) error($('modules'), err); } }
  function renderModules(data) {
    const root = $('modules'); clear(root);
    if (data.truncated) root.append(el('p', t('truncated'), 'notice error'));
    const children = new Map(); (data.modules || []).forEach(m => { const k = m.parent || ''; (children.get(k) || children.set(k, []).get(k)).push(m); });
    const {table:tbl, body} = table(['titleCol', 'status', 'subtasks', 'active', 'completion']); tbl.className = 'compact';
    const draw = (m, depth) => {
      const row = el('tr', undefined, 'clickable'), name = el('td', undefined, 'wrap'), title = el('button', m.title, 'link-button'); title.type = 'button'; name.style.paddingLeft = (10 + Math.min(depth, 4) * 18) + 'px';
      title.addEventListener('click', () => openIssue({id:m.id, title:m.title})); name.append(title, el('span', m.id + ' · P' + m.priority + (m.assignee ? ' · ' + m.assignee : ''), 'sub'));
      const progress = el('td'); progress.append(bar(m.counts.completion));
      row.append(name, el('td', t(m.status)), el('td', num(m.counts.total)), el('td', num(m.counts.active) + (m.counts.blocked ? ' · ' + num(m.counts.blocked) + ' ' + t('blocked') : ''), m.counts.blocked ? 'danger-text' : ''), progress);
      row.addEventListener('click', (event) => { if (!event.target.closest('button')) openIssue({id:m.id, title:m.title}); }); body.append(row);
      (children.get(m.id) || []).forEach(c => draw(c, depth + 1));
    };
    (children.get('') || []).forEach(m => draw(m, 0));
    if (data.unfiled && data.unfiled.total) { const row = el('tr'), progress = el('td'); progress.append(bar(data.unfiled.completion)); row.append(el('td', t('unfiled'), 'wrap'), el('td', '—'), el('td', num(data.unfiled.total)), el('td', num(data.unfiled.active)), progress); body.append(row); }
    if (body.rows.length) { const wrap = el('div', undefined, 'table-wrap'); wrap.append(tbl); root.append(wrap); } else root.append(el('p', t('noModules'), 'empty'));
    const chips = $('repo-scopes'); clear(chips);
    (data.scopes || []).slice(0, 40).forEach(s => { const c = el('span', s.key + ' · ' + num(s.counts.closed) + '/' + num(s.counts.total), 'badge'); c.title = t('completion') + ' ' + s.counts.completion + ' %'; chips.append(c); });
    if (!(data.scopes || []).length) chips.append(el('span', t('none'), 'sub'));
  }
  function openRepo(repo) { selectedRepo = repo; renderRepoHistory(); taskPage = undefined; $('repository-title').textContent = repo.name; $('task-search').value = ''; $('task-status').value = 'all'; $('repository-dialog').showModal(); loadModules(repo); loadTasks(); }
  async function loadTasks(more = false) {
    const request = ++taskRequest; const repo = selectedRepo; if (!repo) return; $('more-tasks').disabled = true; if (!more) message($('tasks'), 'loading');
    const params = new URLSearchParams({status:$('task-status').value, q:$('task-search').value}); if (more && taskPage && taskPage.nextCursor) params.set('cursor', taskPage.nextCursor);
    try { const data = await get('/dashboard/api/repositories/' + encodeURIComponent(repo.id) + '/issues?' + params); if (request !== taskRequest || selectedRepo !== repo) return; taskPage = {...data, items:more ? [...taskPage.items, ...data.items] : data.items}; renderTasks(); }
    catch (err) { if (request === taskRequest) { error($('tasks'), err); $('more-tasks').hidden = true; } }
    finally { if (request === taskRequest) $('more-tasks').disabled = false; }
  }
  function renderTasks() {
    clear($('tasks')); $('task-summary').textContent = num(taskPage.items.length) + ' ' + t('loaded');
    if (!taskPage.items.length) message($('tasks'), taskPage.nextCursor ? 'noPageTasks' : 'noTasks');
    else {
      const {table:tbl, body} = table(['id', 'titleCol', 'status', 'priority', 'owner', 'changedAt']); tbl.className = 'compact';
      taskPage.items.forEach(issue => { const row = el('tr', undefined, 'clickable'), idCell = el('td'), open = el('button', issue.id, 'link-button'); open.type = 'button'; open.addEventListener('click', () => openIssue(issue)); idCell.append(open);
        row.append(idCell, el('td', issue.title, 'wrap'), el('td', t(issue.status), issue.status === 'blocked' ? 'danger-text' : ''), el('td', 'P' + issue.priority), el('td', issue.assignee || t('unassigned')), el('td', date(issue.updated_at)));
        row.addEventListener('click', (event) => { if (!event.target.closest('button')) openIssue(issue); }); body.append(row); });
      const wrap = el('div', undefined, 'table-wrap'); wrap.append(tbl); $('tasks').append(wrap);
    }
    $('more-tasks').hidden = !taskPage.nextCursor;
  }
  async function openIssue(issue, repoId) {
    const request = ++issueRequest; $('issue-title').textContent = issue.title; message($('issue-detail'), 'loading'); $('issue-dialog').showModal();
    try { const data = await get('/dashboard/api/repositories/' + encodeURIComponent(repoId || selectedRepo.id) + '/issues/' + encodeURIComponent(issue.id)); if (request !== issueRequest) return; renderIssue(data.issue || data); }
    catch (err) { if (request === issueRequest) error($('issue-detail'), err); }
  }
  function renderIssue(issue) {
    const root = $('issue-detail'); clear(root); const grid = el('div', undefined, 'detail-grid');
    [['id', issue.id], ['status', t(issue.status)], ['priority', 'P' + issue.priority], ['type', issue.issue_type], ['owner', issue.assignee || issue.owner], ['changedAt', date(issue.updated_at)]].forEach(([key, value]) => { const item = el('div', t(key)); item.append(el('strong', value || t('none'))); grid.append(item); });
    root.append(grid); const labels = el('div', undefined, 'detail-labels'); (issue.labels || []).forEach(l => labels.append(el('span', l, 'badge'))); root.append(labels, el('h3', t('description'), 'block'), el('p', issue.description || t('none'), 'detail-description'));
    const deps = issue.dependencies || []; root.append(el('h3', t('dependencies'), 'block'));
    if (Array.isArray(deps) && deps.length) { const ul = el('ul'); deps.forEach(d => ul.append(el('li', typeof d === 'string' ? d : (d.depends_on_id || d.id || '') + ' · ' + (d.dependency_type || d.type || '')))); root.append(ul); } else root.append(el('p', t('none')));
    root.append(el('h3', t('comments'), 'block')); (issue.comments || []).forEach(c => { const article = el('article', undefined, 'comment'); article.append(el('strong', c.author || t('none')), el('span', date(c.created_at), 'sub'), el('p', c.text || c.body || '')); root.append(article); }); if (!(issue.comments || []).length) root.append(el('p', t('none')));
  }

  // ---------- Routing and events ----------
  const views = ['today', 'projects', 'metrics', 'roadmaps', 'repo', 'state'];
  function route() {
    const hash = location.hash; let match;
    if ((match = /^#(?:repo|roadmap)=(.+)$/.exec(hash))) { view = 'repo'; roadmapRepo = decodeURIComponent(match[1]); }
    else if (hash === '#repo') view = 'repo';
    else if (/^#ms-/.test(hash)) return;
    else if (hash === '#tasks' || hash === '#metrics') view = 'metrics';
    else { const name = hash.slice(1); view = views.includes(name) ? name : 'today'; }
    views.forEach(v => { $('view-' + v).hidden = v !== view; const tab = $('tab-' + v); if (!tab) return; if (v === view || (v === 'roadmaps' && view === 'repo')) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
    $('filter-bar').hidden = !['today', 'projects', 'metrics'].includes(view);
    if (view === 'today') renderToday();
    if (view === 'projects') { if (!milestoneData) loadMilestones(false); else renderProjects(); }
    if (view === 'metrics') { renderMetrics(); if (!scopeData) loadScopes(); if (!healthData) loadHealth(); }
    if (view === 'roadmaps' || view === 'repo') { if (!roadmapRound) loadRoadmaps(); else if (view === 'repo') renderRepoView(); else renderOverview(); }
    if (view === 'state') { if (stateData) renderState(); else loadState(false); }
  }
  function localize() {
    document.documentElement.lang = language; document.querySelectorAll('[data-i18n]').forEach(n => n.textContent = t(n.dataset.i18n));
    document.querySelectorAll('[data-placeholder]').forEach(n => { n.placeholder = t(n.dataset.placeholder); n.setAttribute('aria-label', n.placeholder); });
    $('language').textContent = language === 'de' ? 'EN' : 'DE';
    const status = $('task-status').value || 'all'; clear($('task-status')); ['all', 'open', 'in_progress', 'blocked', 'deferred', 'closed'].forEach(s => { const o = el('option', t(s)); o.value = s; $('task-status').append(o); }); $('task-status').value = status;
    $('history-source').setAttribute('aria-label', t('stSource'));
    document.querySelectorAll('.window').forEach(b => { b.textContent = b.dataset.days + (language === 'de' ? ' T' : ' d'); });
    renderAll(); if (view === 'roadmaps') renderOverview(); if (view === 'repo') renderRepoView(); if (view === 'state' && stateData) renderState(); if (healthData) renderHealth(); if (taskPage) renderTasks(); if (selectedRepo) renderRepoHistory();
  }
  $('language').addEventListener('click', () => { language = language === 'de' ? 'en' : 'de'; try { localStorage.setItem('beads.dashboard.language', language); } catch {} localize(); });
  $('refresh').addEventListener('click', refresh);
  $('filter-group').addEventListener('change', () => { filters.group = $('filter-group').value; filters.repo = ''; saveFilters(); renderAll(); });
  $('filter-repo').addEventListener('change', () => { filters.repo = $('filter-repo').value; saveFilters(); renderAll(); });
  $('filter-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = $('filter-search').value.trim(); renderAll(); }, 200); });
  $('filter-reset').addEventListener('click', () => { filters.group = ''; filters.repo = ''; filters.q = ''; phaseFilter = null; saveFilters(); renderAll(); });
  [['focus-more', 'focus'], ['attention-more', 'attention'], ['working-more', 'working'], ['done-more', 'done']].forEach(([id, key]) => $(id).addEventListener('click', () => { expanded[key] = !expanded[key]; renderToday(); }));
  $('done-dropped').addEventListener('change', () => { showDropped = $('done-dropped').checked; renderToday(); });
  $('show-closed-milestones').addEventListener('change', () => { showClosedMilestones = $('show-closed-milestones').checked; renderProjects(); });
  document.querySelectorAll('.window').forEach(b => b.addEventListener('click', () => { windowDays = Number(b.dataset.days); document.querySelectorAll('.window').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderMetrics(); }));
  [['flow-table-toggle', 'flow-table', 'flow-chart'], ['backlog-table-toggle', 'backlog-table', 'backlog-chart']].forEach(([button, tableId, chartId]) => $(button).addEventListener('click', () => { const show = $(tableId).hidden; $(tableId).hidden = !show; $(chartId).hidden = show; $(button).setAttribute('aria-pressed', String(show)); }));
  $('history-source').addEventListener('change', () => { historySource = $('history-source').value; renderBacklog(); if (selectedRepo) renderRepoHistory(); });
  ['scope-search', 'scope-kind'].forEach(id => $(id).addEventListener(id === 'scope-search' ? 'input' : 'change', renderScopes));
  $('repo-select').addEventListener('change', () => { location.hash = '#repo=' + encodeURIComponent($('repo-select').value); });
  $('roadmap-mode').addEventListener('click', () => { roadmapFull = !roadmapFull; renderRepoView(); });
  $('repo-tasks').addEventListener('click', () => { const source = roadmapList.find(r => r.id === roadmapRepo); if (source) openRepo({id:source.catalogId, name:source.name}); });
  $('close-repository').addEventListener('click', () => $('repository-dialog').close()); $('close-issue').addEventListener('click', () => $('issue-dialog').close());
  $('repository-dialog').addEventListener('close', () => { ++taskRequest; ++moduleRequest; selectedRepo = undefined; }); $('issue-dialog').addEventListener('close', () => ++issueRequest);
  $('task-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadTasks(), 300); }); $('task-status').addEventListener('change', () => loadTasks()); $('more-tasks').addEventListener('click', () => loadTasks(true));
  window.addEventListener('hashchange', route);
  let resizeTimer; if (window.ResizeObserver) new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view === 'metrics' && focus) { drawFlow(); drawBacklog(); } }, 120); }).observe($('main'));
  localize(); route(); loadOverview(); loadFocus(false); loadState(false);
})();
`;
