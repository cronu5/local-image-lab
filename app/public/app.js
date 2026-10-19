'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const activeStatuses = new Set(['loading', 'generating', 'decoding', 'queued', 'starting']);
  const phaseLabels = { loading: 'Loading model', generating: 'Generating image', decoding: 'Decoding image', complete: 'Image saved', cancelled: 'Generation cancelled', error: 'Generation failed', queued: 'Waiting to start', starting: 'Starting generation' };
  let state = null;
  let selectedModelId = null;
  let selectedFormat = 'square';
  let mode = 'create';
  let references = [];
  let selectedImage = null;
  let modelSignature = '';
  let missingSignature = '';
  let gallerySignature = '';
  let lastCompletedJobId = null;
  let submitting = false;
  let uploading = false;
  let expanding = false;
  let enhancementCancelRequested = false;
  let cancelling = false;
  let connected = false;
  let stopped = false;
  let pollTimer = null;
  let toastTimer = null;
  let initialState = true;
  let stateRequest = null;
  let tooltipNumber = 0;

  const isActive = () => Boolean(state?.job && activeStatuses.has(state.job.status));
  const isGenerating = () => submitting || isActive();
  const isEnhancing = () => expanding || Boolean(state?.enhancing);
  const isBusy = () => isGenerating() || uploading || isEnhancing() || Boolean(state?.busy);
  const getModel = () => state?.models?.find((model) => model.id === selectedModelId);
  const maxReferences = () => Math.max(1, Math.min(10, Number(getModel()?.capabilities?.maxReferences) || 1));
  const el = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  };
  function localUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function info(message, label = 'More information') {
    const wrap = el('span', 'info-wrap');
    const button = el('button', 'info-button', 'i');
    button.type = 'button';
    button.dataset.info = 'true';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', 'false');
    const tooltip = el('span', 'info-tooltip', message);
    tooltip.id = `info-${++tooltipNumber}`;
    tooltip.setAttribute('role', 'tooltip');
    button.setAttribute('aria-describedby', tooltip.id);
    wrap.append(button, tooltip);
    return wrap;
  }
  function setInfo(id, message) {
    const tooltip = $(id)?.querySelector('.info-tooltip');
    if (tooltip) tooltip.textContent = message;
  }
  function positionInfo(wrap) {
    if (!wrap || window.innerWidth <= 740) return;
    const button = wrap.querySelector('.info-button');
    const tooltip = wrap.querySelector('.info-tooltip');
    if (!button || !tooltip) return;
    const anchor = button.getBoundingClientRect();
    const width = Math.min(235, window.innerWidth - 32);
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.right - width));
    tooltip.style.setProperty('--tooltip-left', `${left}px`);
    tooltip.style.setProperty('--tooltip-top', `${anchor.bottom}px`);
    const height = tooltip.getBoundingClientRect().height;
    if (height && anchor.bottom + height > window.innerHeight - 12) tooltip.style.setProperty('--tooltip-top', `${Math.max(12, anchor.top - height)}px`);
  }
  function dismissInfo(wrap) {
    wrap.classList.remove('open');
    wrap.classList.add('dismissed');
    wrap.querySelector('.info-button')?.setAttribute('aria-expanded', 'false');
  }
  function duration(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return '';
    const seconds = Math.floor(Number(ms) / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  function dimensions() {
    const edge = Number($('resolution').value) || 768;
    if (selectedFormat === 'landscape') return { width: edge, height: edge * 3 / 4 };
    if (selectedFormat === 'portrait') return { width: edge * 3 / 4, height: edge };
    return { width: edge, height: edge };
  }
  function updateDimensions() {
    const { width, height } = dimensions();
    $('dimensions').textContent = `${width} × ${height}`;
    document.querySelectorAll('[data-format]').forEach((button) => {
      const selected = button.dataset.format === selectedFormat;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }
  function showError(message) {
    $('form-error').textContent = message || '';
    $('form-error').hidden = !message;
  }
  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3500);
  }
  async function request(path, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { cache: 'no-store', ...options, signal: controller.signal });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('The local server returned an unreadable response.'); }
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message || `Request failed (${response.status}).`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The local server took too long to respond. Check the launcher window.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const post = (path, body = {}, timeoutMs = 15000) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);

  function applyDefaults() {
    const defaults = getModel()?.defaults || {};
    $('steps').value = defaults.steps ?? 4;
    $('cfg').value = defaults.cfg ?? 1;
    $('seed').value = -1;
    const width = Number(defaults.width) || 768;
    const height = Number(defaults.height) || 768;
    selectedFormat = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
    const edge = Math.max(width, height);
    $('resolution').value = mode === 'edit' ? '512' : [512, 768, 1024].includes(edge) ? String(edge) : '768';
    updateDimensions();
  }
  function selectModel(id) {
    if (isBusy()) return;
    selectedModelId = id;
    if (!getModel()?.capabilities?.editing) mode = 'create';
    applyDefaults();
    showError('');
    updateModelSelection();
    renderMode();
    renderSettings();
    renderReferences();
    updateControls();
  }
  function renderModels() {
    const models = state?.models || [];
    const signature = JSON.stringify(models.map(({ id, name, description, ready, missing, capabilities, settings }) => ({ id, name, description, ready, missing, capabilities, settings })));
    if (!models.some((model) => model.id === selectedModelId)) {
      const runningModel = isActive() ? models.find((model) => model.id === state.job.modelId) : null;
      selectedModelId = (runningModel || models.find((model) => model.ready) || models[0])?.id || null;
      applyDefaults();
      if (runningModel && initialState) { $('prompt').value = state.job.prompt || ''; $('blank-prompt').checked = state.job.blankPrompt === true; }
    }
    if (signature !== modelSignature) {
      modelSignature = signature;
      const list = $('model-list');
      list.replaceChildren();
      if (!models.length) list.append(el('p', 'muted loading-copy', 'No models are configured. Check the launcher window.'));
      models.forEach((model) => {
        const entry = el('div', 'model-entry');
        const button = el('button', 'model-card');
        button.type = 'button';
        button.dataset.modelId = model.id;
        button.setAttribute('aria-pressed', 'false');
        button.append(el('span', 'model-radio'));
        const content = el('span', 'model-card-content');
        content.append(el('span', 'model-name', model.name));
        if (!model.ready) {
          content.append(el('span', 'model-badge', 'Not ready · missing files'));
          button.title = ['Required files are missing.', ...(model.missing || [])].join('\n');
        }
        button.append(content);
        button.addEventListener('click', () => selectModel(model.id));
        entry.append(button);
        if (model.description) {
          const modelInfo = info(model.description, `About ${model.name}`);
          modelInfo.classList.add('model-info');
          entry.append(modelInfo);
        }
        list.append(entry);
      });
    }
    $('model-count').textContent = `${models.filter((model) => model.ready).length} / ${models.length} ready`;
    updateModelSelection();
  }
  function updateModelSelection() {
    document.querySelectorAll('[data-model-id]').forEach((button) => {
      const selected = button.dataset.modelId === selectedModelId;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const note = $('model-note');
    const unavailable = (state?.models || []).filter((model) => !model.ready);
    note.hidden = unavailable.length === 0;
    const signature = JSON.stringify(unavailable.map((model) => [model.id, model.name, model.missing]));
    if (signature === missingSignature) return;
    missingSignature = signature;
    const contents = $('model-missing');
    contents.replaceChildren();
    unavailable.forEach((model) => {
      contents.append(el('strong', '', `${model.name}: files needed`));
      if (model.missing?.length) {
        const list = el('ul');
        model.missing.forEach((name) => list.append(el('li', '', String(name))));
        contents.append(list);
      } else contents.append(el('span', '', 'Model setup is incomplete. Check the launcher window.'));
    });
  }
  function renderDownload() {
    const download = state?.download;
    const total = Math.max(0, Number(download?.totalBytes) || 0);
    const done = Math.max(0, Number(download?.downloadedBytes) || 0);
    const speed = Math.max(0, Number(download?.bytesPerSecond) || 0);
    const files = Array.isArray(download?.files) ? download.files : [];
    const terminal = new Set(['complete', 'completed', 'done', 'skipped', 'error', 'failed', 'cancelled']);
    const active = total > done && (files.length ? files.some((file) => !terminal.has(String(file.status || '').toLowerCase())) : speed > 0);
    $('download-panel').hidden = !active;
    if (!active) return;
    const percent = Math.max(0, Math.min(100, done / total * 100));
    $('download-percent').textContent = `${Math.floor(percent)}%`;
    $('download-bar').style.width = `${percent}%`;
    $('download-track').setAttribute('aria-valuenow', String(Math.round(percent)));
    $('download-amount').textContent = `${(done / 1e9).toFixed(1)} / ${(total / 1e9).toFixed(1)} GB`;
    const eta = Number(download.etaSeconds);
    let time = '';
    if (download.etaSeconds !== null && download.etaSeconds !== undefined && Number.isFinite(eta) && eta > 0) {
      const minutes = Math.max(1, Math.ceil(eta / 60));
      time = minutes >= 60 ? `~${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `~${minutes}m left`;
    }
    $('download-time').textContent = time || (speed > 0 ? `${(speed / 1e6).toFixed(1)} MB/s` : 'Starting…');
    $('download-panel').title = speed > 0 ? `${(speed / 1e6).toFixed(1)} MB/s` : '';
  }
  function renderSettings() {
    const model = getModel();
    const stepsLocked = Boolean(model?.settings?.stepsLocked);
    const cfgLocked = Boolean(model?.settings?.cfgLocked);
    $('steps-field').hidden = stepsLocked;
    $('cfg-field').hidden = cfgLocked;
    $('numeric-settings').hidden = stepsLocked && cfgLocked;
    $('numeric-settings').classList.toggle('single-field', stepsLocked !== cfgLocked);
    $('advanced').classList.toggle('fixed-settings', stepsLocked && cfgLocked);
    $('fixed-settings-info').hidden = !stepsLocked && !cfgLocked;
    if (stepsLocked) $('steps').value = model.defaults?.steps ?? 8;
    if (cfgLocked) $('cfg').value = model.defaults?.cfg ?? 1;
  }
  function renderMode() {
    const model = getModel();
    const editing = Boolean(model?.capabilities?.editing);
    if (!editing) mode = 'create';
    $('mode-section').hidden = !editing;
    $('reference-section').hidden = mode !== 'edit';
    $('transparency-row').hidden = !model?.capabilities?.transparent;
    $('enhance-row').hidden = mode !== 'create' || !model?.capabilities?.promptExpansion;
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
    const flux = /flux/i.test(`${model?.id || ''} ${model?.name || ''}`);
    $('prompt-label').textContent = mode === 'edit' ? flux ? 'Describe the finished image' : 'Describe your changes' : 'Describe your image';
    $('prompt').placeholder = mode === 'edit'
      ? flux ? 'The same person from image 1, standing in a sunlit forest. Keep their face and clothing, with dappled light and a softly blurred background.' : 'Keep the subject from image 1 and replace the background with a sunlit forest. Preserve the face, clothing and pose.'
      : 'A red canoe on a still alpine lake at dawn, mist between pine-covered mountains, soft golden light. Natural colours, medium-format film.';
    setInfo('prompt-info', mode === 'edit'
      ? flux ? 'Describe the full finished scene, including what to keep and what to change. FLUX works best with a complete description, rather than a short command. Refer to uploads as image 1, image 2, and so on.' : 'Describe what to change and what to preserve. For multiple uploads, refer to image 1, image 2, and so on.'
      : 'Describe the subject, setting, lighting and style. A specific scene description gives the model more to work with.');
    setInfo('reference-info', `Add up to ${maxReferences()} PNG, JPG or WebP images, no more than 10 MB each. Reference copies are resized to at most 1024 px for this setup; originals stay unchanged. References are numbered in upload order. These models can change details and layout.`);
  }
  function renderReferences() {
    const container = $('reference-list');
    container.replaceChildren();
    references.forEach((reference, index) => {
      const card = el('div', 'reference-card');
      const img = el('img');
      img.alt = `Reference ${index + 1}: ${reference.name}`;
      img.src = reference.dataUrl;
      const remove = el('button', 'reference-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove reference ${index + 1}, ${reference.name}`);
      remove.addEventListener('click', () => {
        if (isBusy()) return;
        references.splice(index, 1);
        showError('');
        renderReferences();
        updateControls();
      });
      card.append(img, el('span', 'reference-number', String(index + 1)), remove);
      container.append(card);
    });
    $('reference-count').textContent = `${references.length} / ${maxReferences()}`;
    $('upload-label-text').textContent = references.length ? 'Add more images' : 'Add images';
  }
  async function readReference(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(`${file.name}: use a PNG, JPG or WebP image.`);
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: the image is larger than 10 MB.`);
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    const canvas = document.createElement('canvas');
    try {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`${file.name}: this image could not be opened.`));
        img.src = objectUrl;
      });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error(`${file.name}: this image has no usable dimensions.`);
      const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`${file.name}: could not prepare this reference image.`);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { name: file.name, dataUrl: canvas.toDataURL('image/png') };
    } finally {
      URL.revokeObjectURL(objectUrl);
      img.src = '';
      canvas.width = canvas.height = 0;
    }
  }
  function updateControls() {
    const busy = isBusy();
    const generating = isGenerating();
    const cancellable = generating || isEnhancing();
    const model = getModel();
    ['prompt', 'blank-prompt', 'resolution', 'steps', 'cfg', 'seed', 'random-seed', 'reset-defaults', 'transparent'].forEach((id) => { $(id).disabled = busy || stopped; });
    const blank = $('blank-prompt').checked;
    if (blank) $('transparent').checked = false;
    $('prompt').disabled = busy || stopped || blank;
    $('prompt').required = !blank;
    $('transparent').disabled = busy || stopped || blank;
    $('steps').disabled = busy || stopped || Boolean(model?.settings?.stepsLocked);
    $('cfg').disabled = busy || stopped || Boolean(model?.settings?.cfgLocked);
    document.querySelectorAll('[data-mode], .reference-remove').forEach((button) => { button.disabled = busy || stopped; });
    $('reference-files').disabled = busy || stopped || references.length >= maxReferences();
    $('upload-label').classList.toggle('disabled', $('reference-files').disabled);
    $('enhance').disabled = busy || stopped || !connected || blank || !$('prompt').value.trim();
    $('enhance').textContent = isEnhancing() ? 'Expanding…' : 'Expand prompt';
    document.querySelectorAll('[data-format]').forEach((button) => { button.disabled = busy || stopped; });
    document.querySelectorAll('[data-model-id]').forEach((button) => {
      const found = state?.models?.find((item) => item.id === button.dataset.modelId);
      button.disabled = busy || stopped || !found?.ready;
    });
    $('generate').hidden = cancellable;
    $('generate').disabled = !connected || stopped || busy || !model?.ready || (!blank && !$('prompt').value.trim()) || (mode === 'edit' && (references.length === 0 || references.length > maxReferences()));
    $('cancel').hidden = !cancellable;
    $('cancel').disabled = cancelling || submitting || stopped || !connected;
    $('cancel').textContent = cancelling ? 'Cancelling…' : submitting ? 'Starting…' : isEnhancing() ? 'Cancel expansion' : 'Cancel generation';
    $('generate-label').textContent = !model?.ready && state ? 'Waiting for model files' : 'Generate image';
    $('generate-hint').textContent = generating ? 'The first image may take longer while the model loads.' : isEnhancing() ? 'Expanding locally…' : state?.busy ? 'The local server is working…' : mode === 'edit' && !references.length ? 'Add a reference image to begin' : mode === 'edit' && references.length > maxReferences() ? `Remove ${references.length - maxReferences()} reference image(s) to continue` : 'Ctrl + Enter to generate';
    $('reuse').disabled = busy || stopped || !selectedImage;
    $('shutdown').disabled = busy || stopped || !connected;
    $('open-outputs').disabled = stopped || !connected;
  }

  function updateJobVisibility() {
    const job = state?.job;
    const otherImage = job?.status === 'complete' && selectedImage && job.result?.filename && selectedImage.filename !== job.result.filename;
    $('job-status').hidden = !isEnhancing() && !state?.busy && (!job || Boolean(otherImage));
  }
  function showImage(item) {
    if (!item) return;
    const url = localUrl(item.url);
    if (!url) return;
    selectedImage = item;
    $('empty-state').hidden = true;
    $('preview-image').hidden = false;
    $('image-load-error').hidden = true;
    $('preview-stage').classList.add('has-image');
    $('preview-image').alt = item.prompt || 'Generated image';
    $('preview-image').src = url;
    $('preview-title').textContent = 'Your image';
    $('image-details').hidden = false;
    $('image-model').textContent = item.modelName || state?.models?.find((model) => model.id === item.modelId)?.name || item.modelId || 'Generated image';
    const specs = [];
    if (item.width && item.height) specs.push(`${item.width} × ${item.height}`);
    if (item.seed !== undefined && item.seed !== null) specs.push(`Seed ${item.seed}`);
    if (item.elapsedMs !== undefined && item.elapsedMs !== null) specs.push(duration(item.elapsedMs));
    $('image-specs').textContent = specs.filter(Boolean).join(' · ');
    $('image-prompt').textContent = item.blankPrompt ? 'Blank prompt' : item.prompt || '';
    $('animate-image').href = '/video?image=' + encodeURIComponent(item.filename);
    $('full-image-link').href = url;
    $('download-image').href = url;
    $('download-image').download = item.filename || 'generated-image.png';
    const metadataUrl = localUrl(item.metadataUrl);
    $('metadata-link').hidden = !metadataUrl;
    if (metadataUrl) $('metadata-link').href = metadataUrl;
    document.querySelectorAll('[data-image-name]').forEach((button) => button.classList.toggle('selected', button.dataset.imageName === item.filename));
    updateJobVisibility();
    updateControls();
  }
  function renderGallery() {
    const gallery = Array.isArray(state?.gallery) ? state.gallery : [];
    $('result-count').textContent = gallery.length ? `${gallery.length} image${gallery.length === 1 ? '' : 's'} saved` : '';
    const signature = JSON.stringify(gallery.map((item) => [item.filename, item.url, item.modelName, item.prompt]));
    if (signature === gallerySignature) return;
    gallerySignature = signature;
    const container = $('gallery');
    container.replaceChildren();
    if (!gallery.length) container.append(el('p', 'gallery-empty', 'Your generated images will collect here.'));
    gallery.forEach((item) => {
      const button = el('button', 'gallery-item');
      button.type = 'button';
      button.dataset.imageName = item.filename;
      button.title = [item.modelName || item.modelId || 'Image', item.prompt].filter(Boolean).join('\n');
      button.setAttribute('aria-label', `View ${item.modelName || 'generated'} image: ${item.prompt || item.filename}`);
      button.classList.toggle('selected', item.filename === selectedImage?.filename);
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = localUrl(item.url);
      img.addEventListener('error', () => { img.replaceWith(el('span', 'broken-thumbnail', 'Preview unavailable')); }, { once: true });
      button.append(img, el('span', 'gallery-caption', item.modelName || item.modelId || 'Image'));
      button.addEventListener('click', () => showImage(item));
      container.append(button);
    });
    if (!selectedImage && gallery.length && !isActive()) showImage(gallery[0]);
  }
  function renderJob() {
    const job = state?.job;
    const panel = $('job-status');
    if (isEnhancing() || (state?.busy && !isActive())) {
      panel.hidden = false;
      panel.className = 'job-status running';
      $('job-phase').textContent = isEnhancing() ? 'Expanding prompt' : 'Local server is working';
      $('job-elapsed').textContent = '';
      $('job-message').textContent = '';
      $('progress-track').hidden = true;
      return;
    }
    updateJobVisibility();
    if (!job) return;
    const active = activeStatuses.has(job.status);
    panel.className = `job-status ${active ? 'running' : job.status}`;
    let phase = phaseLabels[job.status] || 'Working';
    if (job.status === 'generating' && Number(job.step) > 0 && Number(job.steps) > 0) phase += ` · step ${job.step} / ${job.steps}`;
    $('job-phase').textContent = phase;
    $('job-elapsed').textContent = job.elapsedMs === undefined || job.elapsedMs === null ? '' : duration(job.elapsedMs);
    const message = job.status === 'error' ? job.error || job.message || 'Generation failed. Check the launcher window for more details.' : job.message || '';
    const repeatsCompletion = job.status === 'complete' && message.trim().replace(/[.!]+$/, '').toLowerCase() === phase.toLowerCase();
    $('job-message').textContent = repeatsCompletion ? '' : message;
    const progress = typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress <= 1 ? job.progress * 100 : job.progress)) : null;
    $('progress-track').hidden = progress === null || !active;
    $('progress-bar').style.width = `${progress || 0}%`;
    if (job.status === 'complete' && job.result && job.id !== lastCompletedJobId) {
      lastCompletedJobId = job.id;
      const item = state.gallery?.find((entry) => entry.filename === job.result.filename) || { ...job, ...job.result };
      if (!initialState || !selectedImage) showImage(item);
    }
  }
  function render() {
    renderModels();
    renderMode();
    renderSettings();
    renderDownload();
    renderGallery();
    renderJob();
    updateControls();
    initialState = false;
  }
  function setConnection(ok, message = '') {
    connected = ok;
    $('connection').className = `connection ${ok ? 'online' : 'offline'}`;
    $('connection-label').textContent = stopped ? 'Stopped' : ok ? 'Local server' : 'Disconnected';
    $('connection-banner').hidden = ok;
    $('connection-banner').textContent = message || 'Cannot reach the local server. Keep the launcher window open; this page will reconnect automatically.';
    updateControls();
  }
  async function refresh() {
    if (stopped) return;
    if (stateRequest) return stateRequest;
    stateRequest = (async () => {
      try {
        const next = await request('/api/state');
        if (!Array.isArray(next.models) || !Array.isArray(next.gallery)) throw new Error('The local server returned incomplete app data.');
        state = next;
        setConnection(true);
        if (next.version) $('version').textContent = `LOCAL / ${next.version}`;
        render();
      } catch (error) { if (!stopped) setConnection(false, error.message === 'Failed to fetch' ? '' : error.message); }
      finally { stateRequest = null; }
    })();
    return stateRequest;
  }
  async function poll() {
    clearTimeout(pollTimer);
    await refresh();
    if (!stopped) pollTimer = setTimeout(poll, isBusy() ? 1000 : 3000);
  }

  $('generate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isBusy() || stopped || !connected || !getModel()?.ready) return;
    const blankPrompt = $('blank-prompt').checked;
    const prompt = blankPrompt ? '' : $('prompt').value.trim();
    if (!prompt && !blankPrompt) { $('prompt').focus(); return; }
    if (mode === 'edit' && (references.length === 0 || references.length > maxReferences())) {
      showError(references.length === 0 ? 'Add at least one reference image.' : `This model accepts up to ${maxReferences()} reference images.`);
      return;
    }
    if (!$('generate-form').reportValidity()) return;
    showError('');
    submitting = true;
    updateControls();
    try {
      const response = await post('/api/generate', { modelId: selectedModelId, mode, prompt, blankPrompt, ...dimensions(), seed: Number($('seed').value), steps: Number($('steps').value), cfg: Number($('cfg').value), references: mode === 'edit' ? references.map(({ name, dataUrl }) => ({ name, dataUrl })) : [], transparent: !blankPrompt && Boolean(getModel()?.capabilities?.transparent) && $('transparent').checked });
      if (response.job && state) state.job = response.job;
      render();
      if (window.innerWidth <= 740) document.querySelector('.preview-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { showError(error.message || 'Could not start generation.'); }
    finally {
      submitting = false;
      updateControls();
      clearTimeout(pollTimer);
      poll();
    }
  });
  $('cancel').addEventListener('click', async () => {
    if (cancelling || submitting || (!isActive() && !isEnhancing())) return;
    if (isEnhancing()) enhancementCancelRequested = true;
    cancelling = true;
    updateControls();
    try { await post('/api/cancel'); await refresh(); }
    catch (error) { enhancementCancelRequested = false; showError(`Could not cancel: ${error.message}`); }
    finally { cancelling = false; updateControls(); }
  });
  $('prompt').addEventListener('input', () => { showError(''); updateControls(); });
  $('blank-prompt').addEventListener('change', () => { if ($('blank-prompt').checked) $('transparent').checked = false; showError(''); updateControls(); });
  $('resolution').addEventListener('change', updateDimensions);
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    if (isBusy() || button.dataset.mode === mode) return;
    mode = button.dataset.mode;
    showError('');
    applyDefaults();
    renderMode();
    renderReferences();
    updateControls();
  }));
  $('reference-files').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (isBusy() || !files.length) return;
    uploading = true;
    showError('');
    updateControls();
    const errors = [];
    try {
      for (const file of files) {
        if (references.length >= maxReferences()) { errors.push(`This model accepts up to ${maxReferences()} reference images.`); break; }
        try { references.push(await readReference(file)); }
        catch (error) { errors.push(error.message); }
      }
    } finally {
      uploading = false;
      renderReferences();
      updateControls();
      if (errors.length) showError(errors.join('\n'));
    }
  });
  $('enhance').addEventListener('click', async () => {
    const prompt = $('prompt').value.trim();
    if (!prompt || $('blank-prompt').checked || isBusy() || !connected || mode !== 'create' || !getModel()?.capabilities?.promptExpansion) return;
    expanding = true;
    enhancementCancelRequested = false;
    showError('');
    renderJob();
    updateControls();
    try {
      const response = await post('/api/enhance', { prompt }, 180000);
      if (typeof response.prompt !== 'string' || !response.prompt.trim()) throw new Error('The prompt helper returned no text. Your original prompt is unchanged.');
      $('prompt').value = response.prompt.trim();
      toast('Prompt expanded. Review or edit it before generating.');
    } catch (error) {
      if (enhancementCancelRequested) toast('Prompt expansion cancelled.');
      else showError(`Prompt expansion failed: ${error.message} You can still generate with your original prompt.`);
    }
    finally { expanding = false; enhancementCancelRequested = false; renderJob(); updateControls(); }
  });
  document.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => { selectedFormat = button.dataset.format; updateDimensions(); }));
  $('random-seed').addEventListener('click', () => {
    const current = Number($('seed').value);
    const random = new Uint32Array(1);
    let seed;
    do { seed = crypto.getRandomValues(random)[0] & 0x7fffffff; } while (seed === current);
    $('seed').value = String(seed);
  });
  $('reset-defaults').addEventListener('click', () => { applyDefaults(); toast('Model defaults restored.'); });
  $('reuse').addEventListener('click', () => {
    if (isBusy() || !selectedImage) return;
    const model = state?.models.find((item) => item.id === selectedImage.modelId && item.ready);
    if (model) selectModel(model.id);
    $('prompt').value = selectedImage.prompt || '';
    $('blank-prompt').checked = selectedImage.blankPrompt === true;
    updateControls();
    $('prompt').focus();
    toast('Prompt reused. Adjust your settings before generating.');
  });
  $('preview-image').addEventListener('error', () => { $('image-load-error').hidden = false; });
  $('preview-image').addEventListener('load', () => { $('image-load-error').hidden = true; });
  $('open-outputs').addEventListener('click', async () => {
    try { await post('/api/open-outputs'); }
    catch (error) { toast(`Could not open outputs: ${error.message}`, true); }
  });
  $('shutdown').addEventListener('click', () => $('shutdown-dialog').showModal());
  $('shutdown-back').addEventListener('click', () => $('shutdown-dialog').close());
  $('shutdown-confirm').addEventListener('click', async () => {
    $('shutdown-confirm').disabled = true;
    try {
      await post('/api/shutdown');
      stopped = true;
      clearTimeout(pollTimer);
      $('shutdown-dialog').close();
      setConnection(false, 'Local Image Lab is stopped. You can close this tab. Use the desktop launcher to open it again.');
    } catch (error) { toast(`Could not stop the server: ${error.message}`, true); }
    finally { $('shutdown-confirm').disabled = false; }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.querySelectorAll('.info-wrap.open, .info-wrap:focus-within, .info-wrap:hover').forEach(dismissInfo);
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('generate').disabled && !$('shutdown-dialog').open) {
      event.preventDefault();
      $('generate-form').requestSubmit();
    }
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-info]');
    const containingWrap = event.target.closest('.info-wrap');
    document.querySelectorAll('.info-wrap.open').forEach((wrap) => {
      if (wrap !== containingWrap) dismissInfo(wrap);
    });
    if (button) {
      event.preventDefault();
      const wrap = button.parentElement;
      if (wrap.classList.contains('open')) dismissInfo(wrap);
      else {
        wrap.classList.remove('dismissed');
        wrap.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
        positionInfo(wrap);
      }
    }
  });
  function revealInfo(event) {
    const wrap = event.target.closest('.info-wrap');
    if (!wrap) return;
    if (!event.relatedTarget || !wrap.contains(event.relatedTarget)) wrap.classList.remove('dismissed');
    positionInfo(wrap);
  }
  document.addEventListener('mouseover', revealInfo);
  document.addEventListener('focusin', revealInfo);
  const repositionInfo = () => {
    document.querySelectorAll('.info-wrap.open, .info-wrap:focus-within, .info-wrap:hover').forEach(positionInfo);
  };
  document.addEventListener('scroll', () => {
    repositionInfo();
  }, true);
  window.addEventListener('resize', repositionInfo);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stopped) { clearTimeout(pollTimer); poll(); }
  });
  document.querySelectorAll('[data-info-text]').forEach((anchor) => anchor.append(info(anchor.dataset.infoText)));
  updateDimensions();
  renderReferences();
  poll();
})();
