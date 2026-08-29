(function () {
  'use strict';

  let data = null;
  let analytics = null;
  const STORAGE_KEY = 'vmone_dashboard_state';
  let state = { schedule: [], tasks: {} };
  let pendingSong = null;
  let pendingSchedule = null;
  let pendingRelease = null;
  let pendingBulkSongs = [];
  let pendingReleaseData = null;

  const PIPELINE_STAGES = [
    { id: 'idea', label: 'Idea', color: 'neutral', next: 'Fill in the New Song form' },
    { id: 'planned', label: 'Planned', color: 'blue', next: 'Generate packages and create Short' },
    { id: 'short-created', label: 'Short Created', color: 'yellow', next: 'Upload to YouTube and add video ID' },
    { id: 'short-scheduled', label: 'Scheduled', color: 'purple', next: 'Post at the scheduled time' },
    { id: 'short-posted', label: 'Short Posted', color: 'green', next: 'Create lyric video' },
    { id: 'lyric-created', label: 'Lyric Created', color: 'yellow', next: 'Upload lyric video' },
    { id: 'lyric-posted', label: 'Lyric Posted', color: 'green', next: 'Mark release complete' },
    { id: 'done', label: 'Done', color: 'green', next: 'Review analytics' }
  ];

  function getStageIndex(stageId) {
    return PIPELINE_STAGES.findIndex((s) => s.id === stageId);
  }

  function getStage(stageId) {
    return PIPELINE_STAGES[getStageIndex(stageId)] || PIPELINE_STAGES[0];
  }

  async function init() {
    try {
      const res = await fetch('content.json?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load content.json');
      data = await res.json();
      data.templates = data.templates || [];
      data.releases = data.releases || [];
      (data.songs || []).forEach((song) => {
        if (!song.pipeline_status) song.pipeline_status = 'planned';
      });
    } catch (err) {
      showError('Could not load content.json. If you are opening this file locally, run a local server with: python -m http.server');
      return;
    }
    loadState();
    (data.songs || []).forEach((song) => {
      if (state.pipeline && state.pipeline[song.id]) {
        song.pipeline_status = state.pipeline[song.id];
      }
    });
    setupTabs();
    setupForms();
    setupDownload();
    await loadAnalytics();
    renderAll();
  }

  async function loadAnalytics() {
    try {
      const res = await fetch('analytics.json?v=' + Date.now(), { cache: 'no-store' });
      if (res.ok) analytics = await res.json();
    } catch (err) {
      analytics = null;
    }
  }

  function showError(msg) {
    const today = document.getElementById('today');
    today.innerHTML = `<div class="error">${msg}</div>`;
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) state = JSON.parse(saved);
    } catch (e) {
      state = { schedule: [], tasks: {}, pipeline: {} };
    }
    if (!state.pipeline) state.pipeline = {};
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // ignore storage errors
    }
    renderProgress();
  }

  function setupTabs() {
    const nav = document.querySelector('nav');
    const tabs = document.querySelectorAll('.tab');
    const buttons = nav.querySelectorAll('button');
    nav.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const target = e.target.dataset.tab;
      buttons.forEach((b) => b.classList.toggle('active', b === e.target));
      tabs.forEach((t) => t.classList.toggle('active', t.id === target));
    });
  }

  function setupForms() {
    const songForm = document.getElementById('new-song-form');
    songForm.addEventListener('submit', (e) => {
      e.preventDefault();
      generateNewSongJson();
    });

    const parseBtn = document.getElementById('parse-ai-json');
    if (parseBtn) {
      parseBtn.addEventListener('click', parseAiJson);
    }

    const suggestBtn = document.getElementById('suggest-date');
    if (suggestBtn) {
      suggestBtn.addEventListener('click', () => {
        document.getElementById('song-date').value = getNextAvailableDate();
      });
    }

    const releaseForm = document.getElementById('release-plan-form');
    if (releaseForm) {
      releaseForm.addEventListener('submit', (e) => {
        e.preventDefault();
        generateReleasePlanPrompt();
      });
    }

    const libraryTabs = document.querySelector('.library-tabs');
    if (libraryTabs) {
      libraryTabs.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') return;
        libraryTabs.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        e.target.classList.add('active');
        document.querySelectorAll('.library-panel').forEach((el) => el.classList.add('hidden'));
        const target = document.getElementById('library-' + e.target.dataset.library);
        if (target) target.classList.remove('hidden');
      });
    }

    const planTabs = document.querySelector('.plan-tabs');
    if (planTabs) {
      planTabs.addEventListener('click', (e) => {
        if (e.target.tagName !== 'BUTTON') return;
        planTabs.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        e.target.classList.add('active');
        document.querySelectorAll('.plan-panel').forEach((el) => el.classList.add('hidden'));
        const target = document.getElementById('plan-' + e.target.dataset.plan);
        if (target) target.classList.remove('hidden');
      });
    }

    const bulkBtn = document.getElementById('bulk-import-btn');
    if (bulkBtn) {
      bulkBtn.addEventListener('click', bulkImportSongs);
    }

    const planSelectAll = document.getElementById('plan-select-all');
    if (planSelectAll) {
      planSelectAll.addEventListener('click', () => {
        document.querySelectorAll('.plan-song-check').forEach((cb) => cb.checked = true);
      });
    }

    const planClearAll = document.getElementById('plan-clear-all');
    if (planClearAll) {
      planClearAll.addEventListener('click', () => {
        document.querySelectorAll('.plan-song-check').forEach((cb) => cb.checked = false);
      });
    }

    const planParseBtn = document.getElementById('plan-parse-release-json');
    if (planParseBtn) {
      planParseBtn.addEventListener('click', parseReleaseJson);
    }

    const generateReleaseBtn = document.getElementById('generate-release-prompt');
    if (generateReleaseBtn) {
      generateReleaseBtn.addEventListener('click', generateReleasePlanPrompt);
    }

    populateReleaseSelect();
  }

  function parseAiJson() {
    const raw = document.getElementById('ai-json-paste').value.trim();
    if (!raw) return;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      alert('Invalid JSON. Copy and paste the full JSON the AI returned, including the outer braces.');
      return;
    }

    // The AI may return a single song, an object with a song key, or an album/EP with tracks.
    let song = obj;
    if (obj.song) song = obj.song;
    if (obj.tracks && Array.isArray(obj.tracks) && obj.tracks.length) song = obj.tracks[0];
    if (!song || typeof song !== 'object') {
      alert('Could not find a song object in the JSON.');
      return;
    }

    const title = song.title || song.working_title || '';
    const genreStr = song.genre || '';
    const genres = Array.isArray(song.genres) ? song.genres : (genreStr ? [genreStr] : []);
    const titleCard = song.title_card || title;
    const hook = (Array.isArray(song.hooks) ? song.hooks[0] : (song.hook || song.hook_idea || ''));
    const lyrics = song.lyrics || song.full_lyrics || hook;
    const notes = song.story || song.visual_concept || song.theme || song.notes || '';
    const monetizationNote = (song.monetization_note || '').toLowerCase();
    const monetization = monetizationNote.includes('growth') || monetizationNote.includes('safe only') ? 'growth-only' : 'monetizable';
    const ip = song.monetization_note || song.ip_note || song.ip_warning || song.avoid || '';
    const distrokid = song.distrokid || song.streaming_link || '';

    document.getElementById('song-title').value = title;
    document.getElementById('song-genres').value = genres.join(', ');
    document.getElementById('song-title-card').value = titleCard;
    document.getElementById('song-hook').value = hook;
    document.getElementById('song-lyrics').value = lyrics;
    document.getElementById('song-notes').value = notes;
    document.getElementById('song-monetization').value = monetization;
    document.getElementById('song-ip').value = ip;
    document.getElementById('song-distrokid').value = distrokid;

    const out = document.getElementById('new-song-output');
    out.classList.remove('hidden');
    out.innerHTML = `<p class="meta">Parsed ${obj.tracks ? 'track 1 of ' + obj.tracks.length : 'single song'}: <strong>${title}</strong>. Review the fields, then click Generate Song JSON.</p>`;
  }

  function setupDownload() {
    const link = document.getElementById('download-json');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      downloadMergedContent();
    });
  }

  function renderAll() {
    renderFlow();
    renderLibrary();
    renderPlan();
    renderToday();
    renderWeek();
    renderNext4Weeks();
    renderReleases();
    renderAnalytics();
    renderTasks();
    renderProgress();
  }

  function getSongById(id) {
    return data.songs.find((s) => s.id === id);
  }

  function isCompleted(index, platform) {
    const saved = state.schedule[index];
    if (saved && saved.completed && typeof saved.completed[platform] === 'boolean') {
      return saved.completed[platform];
    }
    const base = data.schedule[index].completed;
    return base ? base[platform] : false;
  }

  function setCompleted(index, platform, value) {
    if (!state.schedule[index]) state.schedule[index] = {};
    if (!state.schedule[index].completed) state.schedule[index].completed = {};
    state.schedule[index].completed[platform] = value;
    saveState();
    syncCompleteCheckboxes(index, platform, value);
    renderProgress();
  }

  function syncCompleteCheckboxes(index, platform, value) {
    document.querySelectorAll(`.complete-check[data-index="${index}"][data-platform="${platform}"]`).forEach((input) => {
      input.checked = value;
    });
  }

  function isTaskCompleted(id, base) {
    return typeof state.tasks[id] === 'boolean' ? state.tasks[id] : base;
  }

  function setTaskCompleted(id, value) {
    state.tasks[id] = value;
    saveState();
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function getNextAvailableDate() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const ds = toISODate(d);
      const existing = data.schedule.find((s) => s.date === ds);
      if (!existing) return ds;
    }
    return toISODate(today);
  }

  function populateReleaseSelect() {
    const select = document.getElementById('song-release');
    if (!select) return;
    select.innerHTML = '<option value="__new_single__">New single release</option><option value="">No release</option>';
    data.releases.forEach((rel) => {
      select.innerHTML += `<option value="${rel.id}">${escapeHtml(rel.title)} (${rel.type})</option>`;
    });
  }

  function copyToClipboard(text, label) {
    navigator.clipboard.writeText(text).then(() => {
      if (label) alert(`${label} copied to clipboard.`);
    }).catch(() => {
      alert('Copy failed. Please copy manually.');
    });
  }

  function generateSongPackages(song) {
    const title = song.title;
    const titleCard = song.title_card || title;
    const hook = song.hooks && song.hooks[0] ? song.hooks[0] : '';
    const genre = (song.genres || []).join(', ');
    const monetization = song.monetization || 'monetizable';
    const linktree = data.artist.linktree;

    // Question generator
    let question = '';
    const lower = (song.notes || '').toLowerCase();
    const titleLower = title.toLowerCase();
    if (lower.includes('hometown') || titleLower.includes('dac')) {
      question = 'What small town should get a song next?';
    } else if (lower.includes('parrot') || lower.includes('macaw')) {
      question = 'What would you name your macaw?';
    } else if (lower.includes('spider-man') || lower.includes('marvel')) {
      question = 'What was your favorite moment?';
    } else if (lower.includes('ai') || lower.includes('humor')) {
      question = 'What should Suno say next?';
    } else if (lower.includes('night shift')) {
      question = 'What gets you through the night shift?';
    } else if (lower.includes('skinwalker') || lower.includes('ufo')) {
      question = 'What’s the weirdest thing you’ve ever seen?';
    } else if (lower.includes('buc-ee')) {
      question = 'What’s your road trip must-stop?';
    } else if (lower.includes('real') || lower.includes('rent')) {
      question = 'What’s the most relatable line you’ve heard this week?';
    } else {
      question = 'What do you think?';
    }

    // Hashtag generator
    const tags = [];
    if (titleLower.includes('macaw')) { tags.push('#macaw', '#parrot'); }
    if (titleLower.includes('woo')) { tags.push('#woo', '#suno'); }
    if (titleLower.includes('buc')) { tags.push('#bucees', '#roadtrip'); }
    if (titleLower.includes('spider') || titleLower.includes('brand new day')) { tags.push('#spiderman', '#brandnewday', '#marvel'); }
    if (titleLower.includes('real') && titleLower.includes('rent')) { tags.push('#relatable', '#realrap'); }
    if (titleLower.includes('signal') || titleLower.includes('skinwalker')) { tags.push('#skinwalkerranch', '#mystery'); }
    if (titleLower.includes('dacula') || titleLower.includes('dirty dac')) { tags.push('#dacula', '#gwinnettcounty', '#vmone'); }
    if (titleLower.includes('night shift') || titleLower.includes('halo')) { tags.push('#nightshift', '#grackle', '#vmone'); }
    if (!tags.length) {
      tags.push('#' + title.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, ''), '#vmone');
    }
    if (!tags.includes('#vmone')) tags.push('#vmone');
    const igHashtags = tags.slice(0, 5).join(' ');

    const baseCaption = `${titleCard}${titleCard.endsWith('?') ? '' : '.'} ${question}`;

    return {
      youtube_short: {
        title: titleCard,
        caption: `${hook}\n\n${question}`,
        tags: (song.genres || []).concat([title, 'VMOne', 'Suno', 'new music']).slice(0, 15).join(', ')
      },
      youtube_lyric_video: {
        title: `VMOne — ${title} (Official Lyric Video)`,
        description: `${title}\n\n${song.lyrics || hook}\n\nStream / download: ${linktree}\n\nTags: ${igHashtags}`
      },
      instagram_reel: {
        caption: baseCaption,
        hashtags: igHashtags
      },
      facebook_reel: {
        caption: baseCaption.replace(question, question).replace(/\s+/g, ' ').trim()
      },
      threads: {
        caption: `${baseCaption}\n\nFull video: ${linktree}`
      },
      first_comment: data.settings.default_first_comment,
      title_card: titleCard,
      hook: hook
    };
  }

  function renderPackage(label, value, copyLabel) {
    const escaped = escapeHtml(value);
    return `
      <div class="platform-package">
        <h4>${label}</h4>
        <pre>${escaped}</pre>
        <button class="copy-small" data-label="${copyLabel}">Copy ${copyLabel}</button>
      </div>
    `;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderTableRow(label, value, copyLabel) {
    const escaped = escapeHtml(value);
    return `
      <tr>
        <td class="pkg-label">${label}</td>
        <td class="pkg-value"><pre>${escaped}</pre></td>
        <td class="pkg-action"><button class="copy-small" data-label="${copyLabel}">Copy</button></td>
      </tr>
    `;
  }

  function renderToday() {
    const today = todayStr();
    const todayEl = document.getElementById('today');
    const index = data.schedule.findIndex((s) => s.date === today);
    const next = index >= 0 ? data.schedule[index] : data.schedule.find((s) => s.date >= today);

    if (!next) {
      todayEl.innerHTML = '<h2>Today</h2><div class="card"><p>No upcoming posts scheduled.</p></div>';
      return;
    }

    const song = getSongById(next.song_id);
    const pkgs = generateSongPackages(song);
    const isToday = next.date === today;
    const dateDisplay = formatDate(next.date);
    const nextIndex = data.schedule.indexOf(next);

    let html = `<h2>${isToday ? 'Today' : 'Next Up'} — ${dateDisplay}</h2>`;
    html += `<div class="card">`;
    html += `<div class="card-header">`;
    html += `<h3>${song.title}</h3>`;
    html += `<div class="meta"><span class="label">${song.genres.join(', ')}</span><span class="label ${song.monetization}">${song.monetization}</span><span class="label">${song.status}</span></div>`;
    html += `<div class="row">`;
    Object.keys(next.platforms).forEach((platform) => {
      if (next.platforms[platform]) {
        html += `<span class="label">${platformName(platform)} ${next.platforms[platform]}</span>`;
      }
    });
    html += `</div>`;
    html += `</div>`;

    html += `<table class="package-table">`;
    html += `<thead><tr><th>Item</th><th>Text</th><th></th></tr></thead>`;
    html += `<tbody>`;
    html += renderTableRow('YouTube Short title', pkgs.youtube_short.title, 'YT title');
    html += renderTableRow('YouTube Short caption', pkgs.youtube_short.caption, 'YT caption');
    html += renderTableRow('YouTube Short tags', pkgs.youtube_short.tags, 'YT tags');
    html += renderTableRow('Instagram caption', pkgs.instagram_reel.caption + '\n\n' + pkgs.instagram_reel.hashtags, 'IG caption');
    html += renderTableRow('Facebook caption', pkgs.facebook_reel.caption, 'FB caption');
    html += renderTableRow('Threads caption', pkgs.threads.caption, 'Threads caption');
    html += renderTableRow('First comment', pkgs.first_comment, 'first comment');
    html += renderTableRow('Title card', pkgs.title_card, 'title card');
    html += renderTableRow('Hook', pkgs.hook, 'hook');
    html += `</tbody></table>`;

    html += `<div class="row">`;
    Object.keys(next.platforms).forEach((platform) => {
      const name = platformName(platform);
      const checked = isCompleted(nextIndex, platform) ? 'checked' : '';
      html += `<label><input type="checkbox" class="complete-check" data-index="${nextIndex}" data-platform="${platform}" ${checked}> ${name}</label>`;
    });
    html += `</div>`;

    html += `</div>`;
    todayEl.innerHTML = html;
  }

  function platformName(key) {
    const map = {
      'youtube_short': 'YT Short',
      'youtube_lyric_video': 'YT Lyric Video',
      'instagram_reel': 'IG Reel',
      'facebook_reel': 'FB Reel',
      'threads': 'Threads'
    };
    return map[key] || key;
  }

  function pad2(n) {
    return n.toString().padStart(2, '0');
  }

  function toISODate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function getWeekStart(d) {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    start.setDate(start.getDate() - start.getDay());
    return start;
  }

  function buildFullPackageText(song, pkgs) {
    return [
      `Title card: ${pkgs.title_card}`,
      `Hook: ${pkgs.hook}`,
      ``,
      `YouTube Short title: ${pkgs.youtube_short.title}`,
      `YouTube Short caption: ${pkgs.youtube_short.caption}`,
      ``,
      `Instagram caption:`,
      pkgs.instagram_reel.caption,
      pkgs.instagram_reel.hashtags,
      ``,
      `Facebook caption: ${pkgs.facebook_reel.caption}`,
      ``,
      `Threads caption: ${pkgs.threads.caption}`,
      ``,
      `First comment: ${pkgs.first_comment}`
    ].join('\n');
  }

  function renderWeek() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = getWeekStart(today);
    const list = document.getElementById('week-list');
    const todayStr = toISODate(today);

    let html = '<div class="calendar">';
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const dateStr = toISODate(d);
      const entry = data.schedule.find((s) => s.date === dateStr);
      const isPast = dateStr < toISODate(new Date());
      const isToday = dateStr === todayStr;
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      let cellClass = 'day';
      if (isPast) cellClass += ' past';
      if (isToday) cellClass += ' today';

      html += `<div class="${cellClass}" data-date="${dateStr}">`;
      html += `<div class="day-header"><strong>${dayName}</strong><span>${dateLabel}</span></div>`;

      if (entry) {
        const index = data.schedule.indexOf(entry);
        const song = getSongById(entry.song_id);
        const pkgs = generateSongPackages(song);
        const packageText = buildFullPackageText(song, pkgs);
        html += `<div class="day-song">${song.title}</div>`;
        html += `<div class="day-meta"><span class="label ${song.monetization}">${song.monetization}</span></div>`;
        html += `<div class="day-times">`;
        Object.keys(entry.platforms).forEach((platform) => {
          if (entry.platforms[platform]) {
            html += `<span>${platformName(platform)} ${entry.platforms[platform]}</span>`;
          }
        });
        html += `</div>`;
        html += `<pre class="hidden-package">${escapeHtml(packageText)}</pre>`;
        html += `<button class="copy-small day-copy" data-label="full package">Copy full package</button>`;
        html += `<div class="day-checks">`;
        Object.keys(entry.platforms).forEach((platform) => {
          const checked = isCompleted(index, platform) ? 'checked' : '';
          html += `<label><input type="checkbox" class="complete-check" data-index="${index}" data-platform="${platform}" ${checked}> ${platformName(platform)}</label>`;
        });
        html += `</div>`;
      } else {
        html += `<div class="day-empty">No post scheduled</div>`;
      }

      html += `</div>`;
    }
    html += '</div>';
    list.innerHTML = html;
  }

  function renderNext4Weeks() {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const nowStr = toISODate(now);
    const weekStart = getWeekStart(now);
    const list = document.getElementById('next4weeks-list');

    let html = '<div class="calendar" style="grid-template-columns: repeat(7, 1fr);">';
    for (let i = 0; i < 28; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const dateStr = toISODate(d);
      const entry = data.schedule.find((s) => s.date === dateStr);
      const isPast = dateStr < nowStr;
      const isToday = dateStr === nowStr;
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      let cellClass = 'day';
      if (isPast) cellClass += ' past';
      if (isToday) cellClass += ' today';

      html += `<div class="${cellClass}" data-date="${dateStr}">`;
      html += `<div class="day-header"><strong>${dayName}</strong><span>${dateLabel}</span></div>`;

      if (entry) {
        const index = data.schedule.indexOf(entry);
        const song = getSongById(entry.song_id);
        const pkgs = generateSongPackages(song);
        const packageText = buildFullPackageText(song, pkgs);
        html += `<div class="day-song">${song.title}</div>`;
        html += `<div class="day-meta"><span class="label ${song.monetization}">${song.monetization}</span></div>`;
        html += `<div class="day-times">`;
        Object.keys(entry.platforms).forEach((platform) => {
          if (entry.platforms[platform]) {
            html += `<span>${platformName(platform)} ${entry.platforms[platform]}</span>`;
          }
        });
        html += `</div>`;
        html += `<pre class="hidden-package">${escapeHtml(packageText)}</pre>`;
        html += `<button class="copy-small day-copy" data-label="full package">Copy full package</button>`;
        html += `<div class="day-checks">`;
        Object.keys(entry.platforms).forEach((platform) => {
          const checked = isCompleted(index, platform) ? 'checked' : '';
          html += `<label><input type="checkbox" class="complete-check" data-index="${index}" data-platform="${platform}" ${checked}> ${platformName(platform)}</label>`;
        });
        html += `</div>`;
      } else {
        html += `<div class="day-empty">No post scheduled</div>`;
      }

      html += `</div>`;
    }
    html += '</div>';
    list.innerHTML = html;
  }

  function renderLibrary() {
    const lib = document.getElementById('song-library');
    let html = '<input type="text" id="library-search" placeholder="Search songs..." />';
    html += '<div class="song-list">';
    data.songs.forEach((song) => {
      const pkgs = generateSongPackages(song);
      const fullText = buildFullPackageText(song, pkgs);
      const safeId = 'song-' + song.id.replace(/[^a-z0-9]/gi, '-');
      html += `<details class="song-row" data-title="${song.title.toLowerCase()}">`;
      html += `<summary>`;
      html += `<span class="song-title">${song.title}</span>`;
      html += `<span class="label">${song.genres.join(', ')}</span>`;
      html += `<span class="label ${song.monetization}">${song.monetization}</span>`;
      html += `<span class="label">${song.status}</span>`;
      html += `<span class="label stage stage-${song.pipeline_status || 'planned'}">${escapeHtml(getStage(song.pipeline_status).label)}</span>`;
      html += `<pre class="hidden-package" id="${safeId}">${escapeHtml(fullText)}</pre>`;
      html += `<button class="copy-small" data-target="${safeId}" data-label="full package">Copy full</button>`;
      html += `<button class="delete-song" data-delete-id="${song.id}" title="Delete from library">Delete</button>`;
      html += `</summary>`;
      html += `<div class="song-body">`;
      html += `<table class="package-table">`;
      html += `<thead><tr><th>Item</th><th>Text</th><th></th></tr></thead>`;
      html += `<tbody>`;
      html += renderTableRow('YouTube Short title', pkgs.youtube_short.title, 'YT title');
      html += renderTableRow('YouTube Short caption', pkgs.youtube_short.caption, 'YT caption');
      html += renderTableRow('YouTube Short tags', pkgs.youtube_short.tags, 'YT tags');
      html += renderTableRow('YouTube Lyric Video title', pkgs.youtube_lyric_video.title, 'lyric title');
      html += renderTableRow('YouTube Lyric Video description', pkgs.youtube_lyric_video.description, 'lyric description');
      html += renderTableRow('Instagram caption', pkgs.instagram_reel.caption + '\n\n' + pkgs.instagram_reel.hashtags, 'IG caption');
      html += renderTableRow('Facebook caption', pkgs.facebook_reel.caption, 'FB caption');
      html += renderTableRow('Threads caption', pkgs.threads.caption, 'Threads caption');
      html += renderTableRow('First comment', pkgs.first_comment, 'first comment');
      html += renderTableRow('Title card', pkgs.title_card, 'title card');
      html += renderTableRow('Hook', pkgs.hook, 'hook');
      html += `</tbody></table>`;
      if (song.notes || song.ip_note) {
        html += `<p class="meta">${song.notes || ''} ${song.ip_note ? '(' + song.ip_note + ')' : ''}</p>`;
      }
      html += `</div>`;
      html += `</details>`;
    });
    html += `</div>`;
    lib.innerHTML = html;

    const search = document.getElementById('library-search');
    if (search) {
      search.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.song-row').forEach((row) => {
          row.style.display = row.dataset.title.includes(term) ? '' : 'none';
        });
      });
    }
  }

  function deleteSong(songId) {
    const song = data.songs.find((s) => s.id === songId);
    if (!song) return;

    const scheduleCount = data.schedule.filter((s) => s.song_id === songId).length;
    let msg = `Delete "${song.title}" from the library?`;
    if (scheduleCount) {
      msg += ` This will also remove ${scheduleCount} scheduled post${scheduleCount === 1 ? '' : 's'} for this song.`;
    }
    if (!confirm(msg)) return;

    // Save current checkbox overrides keyed by date, then rebuild state indices.
    const completedByDate = {};
    state.schedule.forEach((s, i) => {
      if (s && s.completed && data.schedule[i]) {
        completedByDate[data.schedule[i].date] = s.completed;
      }
    });

    data.songs = data.songs.filter((s) => s.id !== songId);
    data.schedule = data.schedule.filter((s) => s.song_id !== songId);

    state.schedule = data.schedule.map((s) => {
      const completed = completedByDate[s.date] || {};
      return { completed };
    });
    saveState();

    renderToday();
    renderWeek();
    renderLibrary();
    renderProgress();
  }

  function formatNumber(n) {
    return n == null ? '—' : Number(n).toLocaleString();
  }

  function renderAnalytics() {
    const summary = document.getElementById('analytics-summary');
    const table = document.getElementById('analytics-table');

    if (!analytics || !analytics.videos) {
      summary.innerHTML = '<p class="meta">No analytics data yet. Run the GitHub Actions workflow to fetch YouTube stats.</p>';
      table.innerHTML = '';
      return;
    }

    const sorted = analytics.videos.slice().sort((a, b) => (b.latest.views || 0) - (a.latest.views || 0));

    let totals = { views: 0, likes: 0, comments: 0, estimatedMinutesWatched: 0, subscribersGained: 0 };
    sorted.forEach((v) => {
      const l = v.latest || {};
      totals.views += l.views || 0;
      totals.likes += l.likes || 0;
      totals.comments += l.comments || 0;
      totals.estimatedMinutesWatched += l.estimatedMinutesWatched || 0;
      totals.subscribersGained += l.subscribersGained || 0;
    });

    summary.innerHTML = `
      <div class="analytics-cards">
        <div class="stat-card"><strong>${formatNumber(totals.views)}</strong><span>Total Views</span></div>
        <div class="stat-card"><strong>${formatNumber(totals.likes)}</strong><span>Likes</span></div>
        <div class="stat-card"><strong>${formatNumber(totals.comments)}</strong><span>Comments</span></div>
        <div class="stat-card"><strong>${formatNumber(totals.estimatedMinutesWatched)}</strong><span>Est. Minutes</span></div>
        <div class="stat-card"><strong>${formatNumber(totals.subscribersGained)}</strong><span>New Subs</span></div>
      </div>
      <p class="meta">Last updated: ${new Date(analytics.lastUpdated).toLocaleString()}</p>
    `;

    let html = '<table class="analytics-table"><thead><tr>';
    html += '<th>Video</th><th>Type</th><th>Views</th><th>Likes</th><th>Comments</th><th>Watch (min)</th><th>Avg s</th><th>+Subs</th>';
    html += '</tr></thead><tbody>';

    sorted.forEach((v) => {
      const l = v.latest || {};
      html += '<tr>';
      html += `<td class="video-title"><a href="https://www.youtube.com/watch?v=${v.videoId}" target="_blank">${escapeHtml(v.title || v.videoId)}</a></td>`;
      html += `<td>${v.videoType || '—'}</td>`;
      html += `<td class="num">${formatNumber(l.views)}</td>`;
      html += `<td class="num">${formatNumber(l.likes)}</td>`;
      html += `<td class="num">${formatNumber(l.comments)}</td>`;
      html += `<td class="num">${formatNumber(l.estimatedMinutesWatched)}</td>`;
      html += `<td class="num">${formatNumber(l.averageViewDuration)}</td>`;
      html += `<td class="num">${formatNumber(l.subscribersGained)}</td>`;
      html += '</tr>';
    });

    html += '</tbody></table>';
    table.innerHTML = html;
  }

  function renderReleases() {
    const container = document.getElementById('release-list');
    if (!data.releases || !data.releases.length) {
      container.innerHTML = '<p class="meta">No releases planned yet. Use New Song or Release Plan to create one.</p>';
      populateReleaseSelect();
      return;
    }

    const today = todayStr();
    let html = '';
    data.releases.forEach((rel) => {
      const songLookup = rel.songs.reduce((acc, sid) => {
        const song = getSongById(sid);
        if (song) acc[sid] = song;
        return acc;
      }, {});

      const songTitles = Object.values(songLookup).map((s) => s.title).join(', ');

      const releaseSchedule = data.schedule
        .filter((s) => songLookup[s.song_id])
        .sort((a, b) => a.date.localeCompare(b.date));

      const nextPost = releaseSchedule.find((s) => s.date >= today);
      const nextUncompletedTask = (rel.tasks || []).find((t) => !isTaskCompleted(t.id, t.completed));

      const taskList = (rel.tasks || []).map((task) => {
        const completed = isTaskCompleted(task.id, task.completed);
        return `<li><input type="checkbox" class="task-check" data-id="${task.id}" data-release-id="${rel.id}" ${completed ? 'checked' : ''}><span class="${completed ? 'completed' : ''}">${escapeHtml(task.label)}</span></li>`;
      }).join('');

      const total = (rel.tasks || []).length;
      const done = (rel.tasks || []).filter((t) => isTaskCompleted(t.id, t.completed)).length;

      html += `
        <div class="release-card">
          <div class="release-header">
            <h3>${escapeHtml(rel.title)} <span class="label">${rel.type}</span></h3>
            <div class="meta">${rel.startDate}${rel.endDate && rel.endDate !== rel.startDate ? ' – ' + rel.endDate : ''} · ${escapeHtml(songTitles)}</div>
          </div>
          ${nextPost ? `
            <div class="meta" style="margin-top: 0.5rem;">
              <strong>Next post:</strong> ${formatDate(nextPost.date)} — ${escapeHtml(songLookup[nextPost.song_id].title)}
              <div class="day-times" style="margin-top: 0.25rem;">
                ${Object.keys(nextPost.platforms).filter((p) => nextPost.platforms[p]).map((p) => `<span>${platformName(p)} ${nextPost.platforms[p]}</span>`).join('')}
              </div>
            </div>
          ` : '<div class="meta" style="margin-top: 0.5rem;">No upcoming posts for this release.</div>'}
          ${nextUncompletedTask ? `<div class="meta" style="margin-top: 0.5rem;"><strong>Next task:</strong> ${escapeHtml(nextUncompletedTask.label)}</div>` : ''}
          <div class="release-progress">
            <div class="progress-bar" style="--w: ${total ? (done / total) * 100 : 0}%" aria-valuenow="${total ? (done / total) * 100 : 0}" aria-valuemin="0" aria-valuemax="100"></div>
            <span>${done}/${total} complete</span>
          </div>
          ${taskList ? `<ul class="task-list" style="margin-top: 0.75rem;">${taskList}</ul>` : ''}
        </div>
      `;
    });
    container.innerHTML = html;
    populateReleaseSelect();
  }

  function renderPlan() {
    // toggle plan sub-panels
    const active = document.querySelector('.plan-tabs button.active');
    const panel = active ? active.dataset.plan : 'release';
    document.querySelectorAll('.plan-panel').forEach((el) => el.classList.add('hidden'));
    const target = document.getElementById('plan-' + panel);
    if (target) target.classList.remove('hidden');

    const picker = document.getElementById('plan-song-picker');
    if (!picker) return;

    const available = (data.songs || []).filter((s) => !s.release_id && (s.pipeline_status || 'planned') !== 'done');
    if (!available.length) {
      picker.innerHTML = '<p class="meta">No unassigned songs available. Add songs to the Library first.</p>';
      return;
    }

    let html = '';
    available.forEach((song) => {
      html += `
        <label class="song-picker-item">
          <input type="checkbox" class="plan-song-check" value="${song.id}" data-title="${escapeHtml(song.title)}">
          <span class="song-picker-title">${escapeHtml(song.title)}</span>
          <span class="song-picker-meta">${escapeHtml((song.genres || []).join(', ') || '—')} · ${escapeHtml(getStage(song.pipeline_status).label)}</span>
        </label>
      `;
    });
    picker.innerHTML = html;
  }

  function renderFlow() {
    const board = document.getElementById('flow-board');
    const summary = document.getElementById('flow-summary');
    if (!board) return;

    const byStage = {};
    PIPELINE_STAGES.forEach((s) => { byStage[s.id] = []; });
    (data.songs || []).forEach((song) => {
      const stage = song.pipeline_status || 'planned';
      if (!byStage[stage]) byStage[stage] = [];
      byStage[stage].push(song);
    });

    const done = (data.songs || []).filter((s) => s.pipeline_status === 'done').length;
    const total = (data.songs || []).length;
    const upcoming = data.schedule
      .filter((s) => s.date >= todayStr() && !isScheduleCompleted(s))
      .sort((a, b) => a.date.localeCompare(b.date))[0];

    summary.innerHTML = `
      <div class="flow-summary">
        <div><strong>${total}</strong> songs</div>
        <div><strong>${done}</strong> done</div>
        <div><strong>${total - done}</strong> in progress</div>
        <div>Next up: ${upcoming ? `${upcoming.date} — ${escapeHtml(getSongById(upcoming.song_id)?.title || upcoming.song_id)}` : '—'}</div>
      </div>
    `;

    let html = '';
    PIPELINE_STAGES.forEach((stage) => {
      const songs = byStage[stage.id] || [];
      html += `<div class="flow-column flow-${stage.color}">`;
      html += `<h3>${stage.label} <span class="count">${songs.length}</span></h3>`;
      html += `<div class="flow-cards">`;
      if (!songs.length) {
        html += `<p class="empty">No songs in this stage.</p>`;
      } else {
        songs.forEach((song) => {
          const release = data.releases.find((r) => r.id === song.release_id);
          const nextIndex = getStageIndex(stage.id) + 1;
          const canAdvance = nextIndex < PIPELINE_STAGES.length;
          const nextStage = canAdvance ? PIPELINE_STAGES[nextIndex].id : '';
          html += `
            <div class="flow-card" data-song-id="${song.id}">
              <div class="flow-card-title">${escapeHtml(song.title)}</div>
              <div class="flow-card-meta">${escapeHtml(song.monetization || '—')} · ${escapeHtml(song.status || '—')}</div>
              ${release ? `<div class="flow-card-release">${escapeHtml(release.title)}</div>` : ''}
              <div class="flow-card-next">Next: ${stage.next}</div>
              <div class="flow-card-actions">
                <button class="copy-flow" data-song-id="${song.id}" data-label="packages">Copy package</button>
                ${canAdvance ? `<button class="advance-pipeline" data-song-id="${song.id}" data-next="${nextStage}">Mark ${PIPELINE_STAGES[nextIndex].label}</button>` : ''}
              </div>
            </div>
          `;
        });
      }
      html += '</div></div>';
    });
    board.innerHTML = html;
  }

  function isScheduleCompleted(entry) {
    return Object.values(entry.completed || {}).every(Boolean);
  }

  function setPipelineStatus(songId, newStage) {
    const song = data.songs.find((s) => s.id === songId);
    if (!song) return;
    song.pipeline_status = newStage;
    if (!state.pipeline) state.pipeline = {};
    state.pipeline[songId] = newStage;
    saveState();
    renderAll();
  }

  function renderTasks() {
    const list = document.getElementById('task-list');
    if (!list) return;

    let html = '';

    if (data.releases && data.releases.length) {
      html += '<h3>Release checklists</h3>';
      data.releases.forEach((rel) => {
        const total = (rel.tasks || []).length;
        const done = (rel.tasks || []).filter((t) => t.completed).length;
        html += `<h4 class="release-title">${escapeHtml(rel.title)} <span class="meta">${done}/${total}</span></h4>`;
        html += '<ul class="task-list">';
        (rel.tasks || []).forEach((task) => {
          const completed = isTaskCompleted(task.id, task.completed);
          html += `<li><input type="checkbox" class="task-check" data-id="${task.id}" data-release-id="${rel.id}" ${completed ? 'checked' : ''}><span class="${completed ? 'completed' : ''}">${escapeHtml(task.label)}</span></li>`;
        });
        html += '</ul>';
      });
    }

    if (data.tasks && data.tasks.length) {
      html += '<h3>Admin tasks</h3><ul class="task-list">';
      data.tasks.forEach((task) => {
        const completed = isTaskCompleted(task.id, task.completed);
        html += `<li><input type="checkbox" class="task-check" data-id="${task.id}" ${completed ? 'checked' : ''}><span class="${completed ? 'completed' : ''}">${task.label}</span></li>`;
      });
      html += '</ul>';
    }

    list.innerHTML = html || '<p class="meta">No tasks yet. Create a new song or release to generate a checklist.</p>';
  }

  function renderProgress() {
    let total = 0;
    let done = 0;
    data.schedule.forEach((entry, index) => {
      Object.keys(entry.platforms).forEach((platform) => {
        total++;
        if (isCompleted(index, platform)) done++;
      });
    });
    const pct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById('week-progress').textContent = `${pct}%`;
  }

  function getPostPlatforms() {
    const defaultPostTimes = data.settings.default_post_times;
    const platforms = {};
    document.querySelectorAll('.platform-choose input:checked').forEach((input) => {
      const key = input.value;
      if (defaultPostTimes[key]) {
        platforms[key] = defaultPostTimes[key];
      }
    });
    return platforms;
  }

  function generateNewSongJson() {
    const title = document.getElementById('song-title').value.trim();
    const genres = document.getElementById('song-genres').value.split(',').map((s) => s.trim()).filter(Boolean);
    const titleCard = document.getElementById('song-title-card').value.trim();
    const hook = document.getElementById('song-hook').value.trim();
    const lyrics = document.getElementById('song-lyrics').value.trim();
    const notes = document.getElementById('song-notes').value.trim();
    const monetization = document.getElementById('song-monetization').value;
    const ip = document.getElementById('song-ip').value.trim();
    const distrokid = document.getElementById('song-distrokid').value.trim();
    const postDate = document.getElementById('song-date').value || getNextAvailableDate();
    const shortId = document.getElementById('song-youtube-short-id').value.trim();
    const lyricId = document.getElementById('song-youtube-lyric-id').value.trim();
    const releaseSelect = document.getElementById('song-release').value;

    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const song = {
      id,
      title,
      genres,
      title_card: titleCard,
      hooks: [hook],
      lyrics,
      notes,
      monetization,
      ip_note: ip || undefined,
      status: 'Planned',
      pipeline_status: 'planned',
      links: {
        youtube_short: '',
        youtube_short_id: shortId,
        youtube_lyric_id: lyricId,
        distrokid
      }
    };
    const pkgs = generateSongPackages(song);
    pendingSong = song;

    const platforms = getPostPlatforms();
    pendingSchedule = {
      date: postDate,
      song_id: id,
      platforms,
      hook_index: 0,
      completed: {}
    };

    pendingRelease = null;
    if (releaseSelect === '__new_single__') {
      const template = data.templates.find((t) => t.id === 'single-release');
      const steps = template ? template.steps : [
        { id: 'create-short', label: 'Create 9:16 Short hook' },
        { id: 'upload-yt', label: 'Upload to YouTube' }
      ];
      const releaseId = `single-${id}`;
      pendingRelease = {
        id: releaseId,
        title,
        type: 'Single',
        status: 'planned',
        songs: [id],
        startDate: postDate,
        endDate: postDate,
        notes: '',
        tasks: steps.map((step, index) => ({
          id: `${releaseId}-${index}`,
          templateId: step.id,
          label: step.label,
          completed: false,
          song_id: id
        }))
      };
      song.release_id = releaseId;
      pendingSchedule.release_id = releaseId;
    } else if (releaseSelect) {
      song.release_id = releaseSelect;
      pendingSchedule.release_id = releaseSelect;
    }

    const out = document.getElementById('new-song-output');
    out.classList.remove('hidden');
    out.innerHTML = `
      <h3>Song</h3>
      <pre>${escapeHtml(JSON.stringify(song, null, 2))}</pre>
      <button class="copy" data-label="song JSON">Copy Song JSON</button>
      <h3>Schedule</h3>
      <pre>${escapeHtml(JSON.stringify(pendingSchedule, null, 2))}</pre>
      <h3>Release</h3>
      <pre>${escapeHtml(JSON.stringify(pendingRelease, null, 2) || 'none')}</pre>
      <h3>Packages</h3>
      <pre>${escapeHtml(JSON.stringify(pkgs, null, 2))}</pre>
      <button class="save-song" id="save-song-to-json">Add to content.json and save</button>
    `;
  }

  function generateReleasePlanPrompt() {
    const type = document.getElementById('plan-release-type').value;
    const concept = document.getElementById('plan-concept').value.trim();
    const genre = document.getElementById('plan-genre').value.trim();
    const moods = document.getElementById('plan-moods').value.trim();
    const themes = document.getElementById('plan-themes').value.trim();
    const refs = document.getElementById('plan-references').value.trim();
    const avoid = document.getElementById('plan-avoid').value.trim();

    const selectedIds = Array.from(document.querySelectorAll('.plan-song-check:checked')).map((cb) => cb.value);
    const selectedSongs = selectedIds.map((id) => getSongById(id)).filter(Boolean);
    const selectedText = selectedSongs.length
      ? selectedSongs.map((s) => `- ${s.title} (${(s.genres || []).join(', ')})`).join('\n')
      : 'none';

    let prompt = '';
    if (type === 'single') {
      prompt = `Create a concept for one single song by VMOne (an independent rap/pop/dance artist using Suno).\n\n${selectedSongs.length ? 'Selected song: ' + selectedSongs[0].title + '\n' : ''}Song concept: ${concept}\nGenre: ${genre}\nMoods: ${moods}\nTheme words or imagery: ${themes || 'none provided'}\nReference artists or sounds: ${refs || 'none provided'}\nAvoid / IP restrictions: ${avoid || 'none'}\n\nOutput a JSON object with these keys:\n- title\n- genre\n- bpm\n- duration_in_seconds\n- hook (one catchy 1-2 line lyric)\n- title_card (big bold text for the first 1-2 seconds of a 9:16 Short)\n- story (one paragraph)\n- visual_concept (one paragraph)\n- monetization_note (safe or growth-only and why)\n- instagram_caption_question\n\nDo not use emojis. Do not include copyrighted brand names unless explicitly allowed.`;
    } else if (type === 'ep') {
      prompt = `Create an EP plan for VMOne (an independent rap/pop/dance artist using Suno).\n\nConcept: ${concept}\nGenre: ${genre}\nMoods: ${moods}\nTheme words or imagery: ${themes || 'none provided'}\nReference artists or sounds: ${refs || 'none provided'}\nAvoid / IP restrictions: ${avoid || 'none'}\n\nSelected songs from the catalog:\n${selectedText}\n\nUse the selected songs as the track list if enough are provided, or fill in additional tracks to create a cohesive EP. Output a JSON object with:\n- ep_title\n- genre\n- mood_profile\n- total_runtime\n- lead_single (which track number, 1-based)\n- tracks: array of objects with title, role (opener/single/ballad/wildcard/closer), bpm, duration, theme, hook, monetization_note\n\nDo not use emojis. Do not include copyrighted brand names unless explicitly allowed.`;
    } else {
      prompt = `Create a full album plan for VMOne (an independent rap/pop/dance artist using Suno).\n\nConcept: ${concept}\nGenre: ${genre}\nMoods: ${moods}\nTheme words or imagery: ${themes || 'none provided'}\nReference artists or sounds: ${refs || 'none provided'}\nAvoid / IP restrictions: ${avoid || 'none'}\n\nSelected songs from the catalog:\n${selectedText}\n\nUse the selected songs as the basis for the album, or expand with new tracks to create a cohesive record. Output a JSON object with:\n- album_title\n- slug (folder name, kebab-case)\n- genre and style notes\n- mood_profile\n- total_runtime and average track length\n- tracks: array with number, working title, role (opener/single/ballad/wildcard/closer), mood, bpm, duration, one-sentence theme, hook\n- album_story_arc (one paragraph)\n- lead_singles (track numbers)\n- recommended_tags for YouTube and Suno\n\nDo not use emojis. Do not include copyrighted brand names unless explicitly allowed.`;
    }

    const out = document.getElementById('plan-release-output');
    out.classList.remove('hidden');
    out.innerHTML = `
      <h3>Copy-paste this into an AI</h3>
      <pre>${escapeHtml(prompt)}</pre>
      <button class="copy" data-label="AI prompt">Copy Prompt</button>
      <p class="meta">Paste the AI's JSON response into Plan → From AI JSON to import the release.</p>
    `;
  }

  function bulkImportSongs() {
    const raw = document.getElementById('bulk-import-text').value.trim();
    const defaultGenre = document.getElementById('bulk-import-genre').value.trim() || 'rap';
    const defaultStatus = document.getElementById('bulk-import-status').value.trim() || 'Idea';
    if (!raw) return;

    let items = [];

    // 1. JSON array or object
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) items = parsed;
        else if (parsed.songs && Array.isArray(parsed.songs)) items = parsed.songs;
        else if (parsed.tracks && Array.isArray(parsed.tracks)) items = parsed.tracks;
      } catch (err) {
        alert('Invalid JSON. Make sure the pasted text is valid.');
        return;
      }
    } else if (raw.includes(',')) {
      // 2. CSV with optional header
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const first = lines[0];
      const hasHeader = /title/i.test(first);
      const start = hasHeader ? 1 : 0;
      const header = hasHeader ? first.split(',').map((h) => h.trim().toLowerCase()) : [];
      const titleIndex = header.indexOf('title') === -1 ? 0 : header.indexOf('title');
      const genreIndex = header.indexOf('genre') === -1 ? (header.length > 1 ? 1 : -1) : header.indexOf('genre');
      const statusIndex = header.indexOf('status') === -1 ? (header.length > 2 ? 2 : -1) : header.indexOf('status');

      for (let i = start; i < lines.length; i++) {
        const parts = lines[i].split(',').map((s) => s.trim());
        if (!parts[titleIndex]) continue;
        items.push({
          title: parts[titleIndex],
          genres: genreIndex >= 0 && parts[genreIndex] ? parts[genreIndex].split(/\s*;\s*|\s*\/\s*/).filter(Boolean) : [defaultGenre],
          status: statusIndex >= 0 && parts[statusIndex] ? parts[statusIndex] : defaultStatus
        });
      }
    } else {
      // 3. One title per line
      items = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((title) => ({ title, genres: [defaultGenre], status: defaultStatus }));
    }

    pendingBulkSongs = items.map((item) => {
      const title = item.title || item.working_title || '';
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const genres = Array.isArray(item.genres) && item.genres.length ? item.genres : [defaultGenre];
      return {
        id,
        title,
        genres,
        title_card: item.title_card || '',
        hooks: item.hooks || (item.hook ? [item.hook] : []),
        lyrics: item.lyrics || '',
        notes: item.notes || 'Imported from Suno catalog.',
        monetization: item.monetization || 'monetizable',
        ip_note: item.ip_note || '',
        status: item.status || defaultStatus,
        pipeline_status: 'idea',
        links: {
          youtube_short: '',
          youtube_short_id: '',
          youtube_lyric_id: '',
          distrokid: item.distrokid || ''
        }
      };
    });

    const out = document.getElementById('bulk-import-output');
    out.classList.remove('hidden');
    out.innerHTML = `
      <h3>Preview ${pendingBulkSongs.length} songs</h3>
      <pre>${escapeHtml(JSON.stringify(pendingBulkSongs, null, 2))}</pre>
      <button class="save-bulk" id="save-bulk-songs">Add to content.json and save</button>
    `;
  }

  async function saveBulkSongsToContentJson() {
    if (!pendingBulkSongs.length) {
      alert('Preview bulk import first.');
      return;
    }

    let added = 0;
    pendingBulkSongs.forEach((song) => {
      const existing = data.songs.find((s) => s.id === song.id);
      if (existing) {
        if (confirm(`"${song.title}" already exists. Replace it?`)) {
          Object.assign(existing, song);
        }
      } else {
        data.songs.push(song);
        added++;
      }
    });

    pendingBulkSongs = [];
    renderAll();
    alert(`${added} songs added. Use Download updated content.json to save the file.`);
    downloadMergedContent();
  }

  function parseReleaseJson() {
    const raw = document.getElementById('plan-ai-json-paste').value.trim();
    if (!raw) return;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      alert('Invalid JSON. Copy and paste the full AI response.');
      return;
    }

    const release = obj.release || obj.ep || obj.album || { title: obj.ep_title || obj.album_title || 'Untitled', type: 'single' };
    const type = (release.type || 'single').toLowerCase();
    const releaseTitle = release.title || release.ep_title || release.album_title || 'Untitled';
    const releaseId = type + '-' + releaseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    let rawSongs = obj.songs || obj.tracks || [];
    if (!Array.isArray(rawSongs)) rawSongs = [rawSongs];

    const defaultPostTimes = data.settings.default_post_times;
    let nextDate = getNextAvailableDate();
    const songs = [];
    const schedule = [];

    rawSongs.forEach((track, index) => {
      const title = track.title || track.working_title || '';
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const song = {
        id,
        title,
        genres: Array.isArray(track.genres) && track.genres.length ? track.genres : [track.genre || 'rap'],
        title_card: track.title_card || '',
        hooks: track.hook ? [track.hook] : (track.hooks || []),
        lyrics: track.lyrics || '',
        notes: track.notes || track.theme || '',
        monetization: track.monetization || track.monetization_note || 'monetizable',
        ip_note: track.ip_note || '',
        status: 'Planned',
        pipeline_status: 'planned',
        release_id: releaseId,
        links: {
          youtube_short: '',
          youtube_short_id: '',
          youtube_lyric_id: '',
          distrokid: ''
        }
      };
      songs.push(song);

      const platforms = {};
      Object.keys(defaultPostTimes).forEach((key) => {
        if (key !== 'youtube_lyric_video' || type === 'single') platforms[key] = defaultPostTimes[key];
      });

      schedule.push({
        date: nextDate,
        song_id: id,
        release_id: releaseId,
        platforms,
        hook_index: 0,
        completed: {}
      });

      const d = new Date(nextDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      nextDate = toISODate(d);
    });

    const template = data.templates.find((t) => t.id === (type === 'single' ? 'single-release' : 'ep-release'));
    const steps = template ? template.steps : [];
    const tasks = [];
    songs.forEach((song) => {
      steps.forEach((step, i) => {
        tasks.push({
          id: `${releaseId}-${song.id}-${i}`,
          templateId: step.id,
          label: step.label,
          completed: false,
          song_id: song.id
        });
      });
    });

    pendingReleaseData = {
      release: {
        id: releaseId,
        title: releaseTitle,
        type: type === 'ep' ? 'EP' : (type === 'album' ? 'Album' : 'Single'),
        status: 'planned',
        songs: songs.map((s) => s.id),
        startDate: schedule.length ? schedule[0].date : toISODate(new Date()),
        endDate: schedule.length ? schedule[schedule.length - 1].date : toISODate(new Date()),
        notes: release.notes || '',
        tasks
      },
      songs,
      schedule
    };

    const out = document.getElementById('plan-ai-json-output');
    out.classList.remove('hidden');
    out.innerHTML = `
      <h3>Preview release</h3>
      <pre>${escapeHtml(JSON.stringify(pendingReleaseData, null, 2))}</pre>
      <button class="save-release" id="save-release-json">Add to content.json and save</button>
    `;
  }

  async function saveReleaseDataToContentJson() {
    if (!pendingReleaseData) {
      alert('Preview the AI JSON first.');
      return;
    }

    pendingReleaseData.songs.forEach((song) => {
      const existing = data.songs.find((s) => s.id === song.id);
      if (existing) Object.assign(existing, song);
      else data.songs.push(song);
    });

    pendingReleaseData.schedule.forEach((s) => data.schedule.push(s));

    const existingRelease = data.releases.find((r) => r.id === pendingReleaseData.release.id);
    if (existingRelease) Object.assign(existingRelease, pendingReleaseData.release);
    else data.releases.push(pendingReleaseData.release);

    pendingReleaseData = null;
    renderAll();
    alert('Release added. Use Download updated content.json to save the file.');
    downloadMergedContent();
  }

  function getMergedData() {
    const merged = JSON.parse(JSON.stringify(data));
    state.schedule.forEach((s, index) => {
      if (s.completed && merged.schedule[index]) {
        Object.assign(merged.schedule[index].completed, s.completed);
      }
    });
    merged.tasks.forEach((task) => {
      if (typeof state.tasks[task.id] === 'boolean') {
        task.completed = state.tasks[task.id];
      }
    });
    (merged.releases || []).forEach((rel) => {
      (rel.tasks || []).forEach((task) => {
        if (typeof state.tasks[task.id] === 'boolean') {
          task.completed = state.tasks[task.id];
        }
      });
    });
    return merged;
  }

  function getMergedJson() {
    return JSON.stringify(getMergedData(), null, 2);
  }

  function downloadMergedContent() {
    const blob = new Blob([getMergedJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'content.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveSongToContentJson() {
    if (!pendingSong) {
      alert('Generate a song JSON first.');
      return;
    }

    const existingIndex = data.songs.findIndex((s) => s.id === pendingSong.id);
    if (existingIndex >= 0) {
      if (!confirm(`A song with id "${pendingSong.id}" already exists. Replace it?`)) return;
      data.songs[existingIndex] = pendingSong;
    } else {
      data.songs.push(pendingSong);
    }

    if (pendingSchedule) {
      const existingSchedule = data.schedule.findIndex((s) => s.song_id === pendingSchedule.song_id && s.date === pendingSchedule.date);
      if (existingSchedule >= 0) {
        data.schedule[existingSchedule] = pendingSchedule;
      } else {
        data.schedule.push(pendingSchedule);
      }
    }

    if (pendingRelease) {
      const existingRelease = data.releases.findIndex((r) => r.id === pendingRelease.id);
      if (existingRelease >= 0) {
        data.releases[existingRelease] = pendingRelease;
      } else {
        data.releases.push(pendingRelease);
      }
    }

    pendingSong = null;
    pendingSchedule = null;
    pendingRelease = null;

    renderAll();

    const json = getMergedJson();

    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'content.json',
          types: [{ description: 'JSON files', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        alert('content.json saved. Refresh the page to load the updated file.');
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err);
          alert('Save failed. Falling back to download.');
          downloadMergedContent();
        }
      }
    } else {
      alert('Your browser does not support direct file saving. A download will start instead.');
      downloadMergedContent();
    }
  }

  // Global copy / checkbox event delegation
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('button.copy, button.copy-small');
    if (btn) {
      let text = '';
      if (btn.dataset.target) {
        const el = document.getElementById(btn.dataset.target);
        text = el ? el.textContent : '';
      } else {
        const tr = btn.closest('tr');
        if (tr) {
          const preCell = tr.querySelector('.pkg-value pre');
          text = preCell ? preCell.textContent : '';
        } else {
          const pre = btn.previousElementSibling;
          text = pre ? pre.textContent : '';
        }
      }
      copyToClipboard(text, btn.dataset.label);
    }

    const deleteBtn = e.target.closest('.delete-song');
    if (deleteBtn) {
      deleteSong(deleteBtn.dataset.deleteId);
    }

    const saveBtn = e.target.closest('.save-song');
    if (saveBtn) {
      saveSongToContentJson();
    }

    const saveBulkBtn = e.target.closest('.save-bulk');
    if (saveBulkBtn) {
      saveBulkSongsToContentJson();
    }

    const saveReleaseBtn = e.target.closest('.save-release');
    if (saveReleaseBtn) {
      saveReleaseDataToContentJson();
    }

    const advanceBtn = e.target.closest('.advance-pipeline');
    if (advanceBtn) {
      setPipelineStatus(advanceBtn.dataset.songId, advanceBtn.dataset.next);
    }

    const copyFlowBtn = e.target.closest('.copy-flow');
    if (copyFlowBtn) {
      const song = getSongById(copyFlowBtn.dataset.songId);
      if (song) {
        const pkgs = generateSongPackages(song);
        copyToClipboard(JSON.stringify(pkgs, null, 2), copyFlowBtn.dataset.label || 'packages');
      }
    }
  });

  document.body.addEventListener('change', (e) => {
    if (e.target.classList.contains('complete-check')) {
      const index = parseInt(e.target.dataset.index, 10);
      const platform = e.target.dataset.platform;
      setCompleted(index, platform, e.target.checked);
    }
    if (e.target.classList.contains('task-check')) {
      setTaskCompleted(e.target.dataset.id, e.target.checked);
      e.target.nextElementSibling.classList.toggle('completed', e.target.checked);
      renderReleases();
      renderTasks();
    }
  });

  init();
})();
