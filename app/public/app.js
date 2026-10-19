'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const activeStatuses = new Set(['loading', 'generating', 'decoding', 'queued', 'starting']);
  const phaseLabels = { loading: 'Loading model', generating: 'Generating image', decoding: 'Decoding image', complete: 'Image saved', cancelled: 'Generation cancelled', error: 'Generation failed', queued: 'Waiting to start', starting: 'Starting generation' };
  const samplerLabels = { euler: 'Euler', euler_a: 'Euler ancestral', heun: 'Heun · 2×', dpm2: 'DPM2 · 2×', 'dpm++2s_a': 'DPM++ 2S ancestral · 2×', 'dpm++2m': 'DPM++ 2M', 'dpm++2mv2': 'DPM++ 2M v2', ipndm: 'iPNDM', ipndm_v: 'iPNDM-V', lcm: 'LCM', ddim_trailing: 'DDIM trailing', tcd: 'TCD', res_multistep: 'RES multistep', res_2s: 'RES 2S · 2×', er_sde: 'ER-SDE', euler_cfg_pp: 'Euler CFG++', euler_a_cfg_pp: 'Euler ancestral CFG++', euler_ge: 'Euler GE', 'dpm++2m_sde': 'DPM++ 2M SDE', 'dpm++2m_sde_bt': 'DPM++ 2M SDE · Brownian', lms: 'LMS' };
  const schedulerLabels = { discrete: 'Discrete', karras: 'Karras', exponential: 'Exponential', ays: 'Align Your Steps', gits: 'GITS', sgm_uniform: 'SGM uniform', simple: 'Simple', smoothstep: 'Smoothstep', kl_optimal: 'KL optimal', lcm: 'LCM', bong_tangent: 'Bong tangent', logit_normal: 'Logit-normal', beta: 'Beta', flux: 'Flux', flux2: 'Flux 2' };
  const MASK_COLOR = '#ff5a4a';
  let state = null;
  let selectedModelId = null;
  let references = [];
  let startImage = null;
  let maskCanvas = null;
  let maskDataUrl = '';
  let brush = 'paint';
  let selectedImage = null;
  let modelSignature = '';
  let missingSignature = '';
  let gallerySignature = '';
  let optionsSignature = '';
  let loraSignature = '';
  let upscalerSignature = '';
  let livePreviewUrl = '';
  const loraChoices = {};
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
  const options = () => getModel()?.options || {};
  const maxReferences = () => Math.max(1, Math.min(10, Number(options().references || getModel()?.capabilities?.maxReferences) || 1));
  const maxSize = () => Number(options().maxSize) || 2048;
  const turbo = () => $('scheduler').value === 'turbo';
  const el = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  };
  const round32 = (value) => Math.max(256, Math.min(maxSize(), Math.round(value / 32) * 32));
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
  function fillSelect(select, values, labels, fallback) {
    const previous = select.value;
    select.replaceChildren(...values.map(([value, label]) => { const option = el('option', '', label || labels?.[value] || value); option.value = value; return option; }));
    select.value = values.some(([value]) => value === previous) ? previous : fallback;
  }

  // ---- Size ----
  function inputShape() {
    const source = startImage || references[0];
    return source?.width && source?.height ? source.width / source.height : null;
  }
  function dimensions() {
    const aspect = $('aspect').value;
    if (aspect === 'custom') return { width: round32(Number($('custom-width').value) || 768), height: round32(Number($('custom-height').value) || 768) };
    const edge = Number($('resolution').value) || 768;
    let ratio = 1;
    if (aspect === 'match') ratio = inputShape() || 1;
    else { const [a, b] = aspect.split(':').map(Number); if (a > 0 && b > 0) ratio = a / b; }
    return ratio >= 1 ? { width: round32(edge), height: round32(edge / ratio) } : { width: round32(edge * ratio), height: round32(edge) };
  }
  function hiresSize() {
    const { width, height } = dimensions();
    const scale = Number($('hires-scale').value) || 1.5;
    return { width: Math.round(width * scale / 32) * 32, height: Math.round(height * scale / 32) * 32 };
  }
  function updateDimensions() {
    const { width, height } = dimensions();
    const custom = $('aspect').value === 'custom';
    $('custom-size').hidden = !custom;
    $('edge-row').hidden = custom;
    const hires = $('hires').checked;
    const final = hiresSize();
    const sharpen = $('post-upscale').value ? 4 : 1;
    const shown = hires ? final : { width, height };
    $('dimensions').textContent = hires || sharpen > 1 ? `${width} × ${height} → ${shown.width * sharpen} × ${shown.height * sharpen}` : `${width} × ${height}`;
    $('hires-size').textContent = `Final size: ${final.width} × ${final.height}${final.width > maxSize() || final.height > maxSize() ? ` · too large, keep within ${maxSize()} px` : ''}`;
    $('upscale-state').textContent = hires || sharpen > 1 ? `${shown.width * sharpen} × ${shown.height * sharpen}` : 'Off';
    document.querySelectorAll('[data-format]').forEach((button) => {
      const selected = button.dataset.format === $('aspect').value;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const matchOption = $('aspect').querySelector('option[value="match"]');
    matchOption.textContent = startImage ? 'Match start image' : references.length ? 'Match image 1' : 'Match input image · add one first';
  }
  function useMatchingShape() {
    if (inputShape() && $('aspect').value !== 'custom') $('aspect').value = 'match';
    updateDimensions();
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

  // ---- Model defaults and options ----
  function applyModelDefaults() {
    const model = getModel();
    const defaults = model?.defaults || {};
    renderOptions(true);
    $('steps').value = defaults.steps ?? 16;
    $('cfg').value = defaults.cfg ?? 1;
    $('sampler').value = defaults.sampler || 'euler';
    $('scheduler').value = defaults.scheduler || 'default';
    $('eta').value = '';
    $('flow-shift').value = '';
    $('hires-upscaler').value = defaults.hiresUpscaler || 'Lanczos';
    $('hires-strength').value = defaults.hiresStrength ?? 0.5;
    $('hires-steps').value = 0;
    syncRanges();
  }
  function restoreDefaults() {
    const defaults = getModel()?.defaults || {};
    applyModelDefaults();
    $('seed').value = -1;
    const width = Number(defaults.width) || 768;
    const height = Number(defaults.height) || 768;
    $('aspect').value = inputShape() ? 'match' : width === height ? '1:1' : width > height ? '4:3' : '3:4';
    const edge = Math.max(width, height);
    $('resolution').value = [...$('resolution').options].some((option) => Number(option.value) === edge) ? String(edge) : '768';
    $('batch').value = '1';
    $('tiling').value = 'off';
    $('cache').value = 'off';
    $('live-preview').checked = true;
    $('hires').checked = false;
    $('hires-scale').value = defaults.hiresScale ?? 1.5;
    $('strength').value = defaults.strength ?? 0.75;
    syncRanges();
    updateDimensions();
  }
  function renderOptions(force = false) {
    const model = getModel();
    if (!model) return;
    const opts = model.options || {};
    const signature = JSON.stringify([model.id, opts.samplers, opts.schedulers, opts.hiresUpscalers, opts.turboSchedule]);
    if (!force && signature === optionsSignature) return;
    optionsSignature = signature;
    fillSelect($('sampler'), (opts.samplers || ['euler']).map((value) => [value, value === model.defaults?.sampler ? `${samplerLabels[value] || value} · default` : '']), samplerLabels, model.defaults?.sampler || 'euler');
    const schedules = [];
    if (opts.turboSchedule) schedules.push(['turbo', 'Turbo · 8 steps · default']);
    schedules.push(['default', opts.turboSchedule ? 'Model schedule · any steps' : 'Model default · shifted']);
    (opts.schedulers || []).forEach((value) => schedules.push([value, '']));
    fillSelect($('scheduler'), schedules, schedulerLabels, model.defaults?.scheduler || 'default');
    fillSelect($('hires-upscaler'), (opts.hiresUpscalers || ['Lanczos']).map((value) => [value, value === model.defaults?.hiresUpscaler ? `${value} · default` : '']), null, model.defaults?.hiresUpscaler || 'Lanczos');
  }
  function syncRanges() {
    $('strength-value').textContent = Number($('strength').value).toFixed(2);
    $('hires-strength-value').textContent = Number($('hires-strength').value).toFixed(2);
  }

  function selectModel(id) {
    if (isBusy()) return;
    selectedModelId = id;
    if (!getModel()?.capabilities?.editing) references = [];
    applyModelDefaults();
    showError('');
    updateModelSelection();
    renderInputs();
    renderSettings();
    renderLoras(true);
    renderReferences();
    updateDimensions();
    updateControls();
  }
  function renderModels() {
    const models = state?.models || [];
    const signature = JSON.stringify(models.map(({ id, name, description, ready, missing, capabilities, settings }) => ({ id, name, description, ready, missing, capabilities, settings })));
    if (!models.some((model) => model.id === selectedModelId)) {
      const runningModel = isActive() ? models.find((model) => model.id === state.job.modelId) : null;
      selectedModelId = (runningModel || models.find((model) => model.ready) || models[0])?.id || null;
      applyModelDefaults();
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
    const opts = model?.options || {};
    renderOptions();
    const isTurbo = turbo();
    if (isTurbo) $('steps').value = 8;
    setInfo('steps-info', isTurbo
      ? 'The Turbo schedule always uses its 8 trained steps. Choose another schedule to set your own number of steps; Turbo is tuned for its own schedule, so other choices are experimental.'
      : `How many refinement passes the model makes. More steps take longer and do not always improve quality. ${model?.name || 'This model'} default: ${model?.defaults?.steps ?? 16}.`);
    setInfo('scheduler-info', opts.turboSchedule
      ? 'How the noise level drops from step to step. Turbo is the 8-step schedule this model was trained for and gives the best results. Model schedule and the others accept any number of steps and are experimental with Turbo.'
      : 'How the noise level drops from step to step. Model default is the shifted schedule FLUX 3 was made for. Others are experimental; Flow shift changes the default schedule.');
    const showEta = (opts.etaSamplers || []).includes($('sampler').value);
    const showShift = Boolean(opts.flowShift);
    $('eta-field').hidden = !showEta;
    $('shift-field').hidden = !showShift;
    $('noise-settings').hidden = !showEta && !showShift;
    $('noise-settings').classList.toggle('single-field', showEta !== showShift);
    $('hires-options').hidden = !$('hires').checked;
    $('hires-steps-field').hidden = isTurbo;
    setInfo('hires-strength-info', isTurbo
      ? 'How much the enlarged image is redrawn. Lower stays closer to the first pass; higher adds more new detail but can change things. Qwen Turbo default 0.7. Values near 1 start again from almost pure noise.'
      : 'How much the enlarged image is redrawn. Lower stays closer to the first pass; higher adds more new detail but can change things. Default 0.5.');
    $('transparency-row').hidden = !opts.transparent;
  }
  function renderLoras(force = false) {
    const model = getModel();
    const loras = model?.loras || [];
    const choices = loraChoices[model?.id] || (loraChoices[model?.id || ''] = {});
    const signature = JSON.stringify([model?.id, loras.map((lora) => lora.name)]);
    const active = loras.filter((lora) => choices[lora.name]?.on);
    $('lora-state').textContent = active.length ? `${active.length} on` : loras.length ? `${loras.length} available` : 'None';
    if (!force && signature === loraSignature) return;
    loraSignature = signature;
    const list = $('lora-list');
    list.replaceChildren();
    loras.forEach((lora, index) => {
      const choice = choices[lora.name] || (choices[lora.name] = { on: false, weight: 1 });
      const row = el('div', 'lora-row');
      const label = el('label', 'toggle-label');
      const box = el('input');
      box.type = 'checkbox';
      box.id = `lora-${index}`;
      box.checked = choice.on;
      label.htmlFor = box.id;
      label.title = `${lora.file} · ${(lora.size / 1e6).toFixed(1)} MB`;
      label.append(box, el('span', 'toggle-track'), el('span', 'lora-name', lora.name));
      const weight = el('input', 'lora-weight');
      weight.type = 'number';
      weight.min = '-4';
      weight.max = '4';
      weight.step = '0.05';
      weight.value = String(choice.weight);
      weight.setAttribute('aria-label', `Strength of ${lora.name}`);
      box.addEventListener('change', () => { choice.on = box.checked; renderLoras(); updateControls(); });
      weight.addEventListener('input', () => { choice.weight = Number(weight.value); });
      row.append(label, weight);
      list.append(row);
    });
    $('lora-hint').textContent = loras.length
      ? `Switch a LoRA on to use it. Strength 1 is normal, lower is subtler and negative values push the other way. LoRAs must be made for ${model.name}. Files: ${model.loraFolder}.`
      : `No LoRAs for ${model?.name || 'this model'} yet. Put LoRA files made for this model (.safetensors or .gguf) in ${model?.loraFolder || 'models\\loras'}. They appear here automatically.`;
    updateControls();
  }
  function renderUpscalers() {
    const upscalers = Array.isArray(state?.upscalers) ? state.upscalers : [];
    const signature = JSON.stringify(upscalers.map((item) => item.file));
    $('post-upscale-row').hidden = !upscalers.length;
    $('upscale-image').hidden = !upscalers.length;
    $('upscaler-hint').hidden = upscalers.length > 0;
    $('upscaler-hint').textContent = 'To sharpen images 4× after they are made, put an upscaler model (.pth) in models\\upscalers.';
    if (signature === upscalerSignature) return;
    upscalerSignature = signature;
    fillSelect($('post-upscale'), [['', 'Off'], ...upscalers.map((item) => [item.file, item.name])], null, '');
  }
  function selectedLoras() {
    const model = getModel();
    const choices = loraChoices[model?.id] || {};
    return (model?.loras || []).filter((lora) => choices[lora.name]?.on).map((lora) => ({ name: lora.name, weight: Number(choices[lora.name].weight) }));
  }

  // ---- Inputs: references, start image and mask ----
  function renderInputs() {
    const model = getModel();
    const opts = model?.options || {};
    const editing = Boolean(model?.capabilities?.editing);
    if (!editing && references.length) references = [];
    $('reference-section').hidden = !editing;
    $('start-section').hidden = !opts.startImage;
    $('enhance-row').hidden = references.length > 0 || !model?.capabilities?.promptExpansion;
    const flux = /flux/i.test(`${model?.id || ''} ${model?.name || ''}`);
    let label = 'Describe your image';
    let placeholder = 'A red canoe on a still alpine lake at dawn, mist between pine-covered mountains, soft golden light. Natural colours, medium-format film.';
    let promptInfo = 'Describe the subject, setting, lighting and style. A specific scene description gives the model more to work with.';
    if (references.length) {
      label = flux ? 'Describe the finished image' : 'Describe your changes';
      placeholder = flux ? 'The same person from image 1, standing in a sunlit forest. Keep their face and clothing, with dappled light and a softly blurred background.' : 'Keep the subject from image 1 and replace the background with a sunlit forest. Preserve the face, clothing and pose.';
      promptInfo = flux ? 'Describe the full finished scene, including what to keep and what to change. FLUX works best with a complete description, rather than a short command. Refer to uploads as image 1, image 2, and so on.' : 'Describe what to change and what to preserve. For multiple uploads, refer to image 1, image 2, and so on.';
    } else if (startImage) {
      label = 'Describe the finished image';
      placeholder = maskDataUrl ? 'A blue ceramic cup on the wooden table, soft studio light.' : 'The same scene at sunset, warm orange light and long shadows.';
      promptInfo = maskDataUrl ? 'Describe what should appear in the painted area, in the style of the rest of the picture. Only the painted area is redrawn.' : 'Describe the whole picture you want, including what should stay. Change strength decides how much can change.';
    }
    $('prompt-label').textContent = label;
    $('prompt').placeholder = placeholder;
    setInfo('prompt-info', promptInfo);
    setInfo('reference-info', `The model looks at these while it creates your image, for editing, combining people or objects, or copying a style. Add up to ${maxReferences()} PNG, JPG or WebP images, no more than 10 MB each. Copies are resized to at most 1024 px; originals stay unchanged. References are numbered in upload order. You can also drag images here or paste one with Ctrl + V. These models can change details and layout.`);
    $('reference-count').textContent = `${references.length} / ${maxReferences()}`;
    $('start-card').hidden = !startImage;
    $('start-label').hidden = Boolean(startImage);
    $('strength-field').hidden = !startImage;
    $('clear-mask').hidden = !maskDataUrl;
    $('paint-mask').textContent = maskDataUrl ? 'Edit mask' : 'Paint mask';
    $('mask-note').textContent = maskDataUrl ? 'Changes the painted area' : 'Changes the whole image';
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
        renderInputs();
        updateDimensions();
        updateControls();
      });
      card.append(img, el('span', 'reference-number', String(index + 1)), remove);
      container.append(card);
    });
    $('reference-count').textContent = `${references.length} / ${maxReferences()}`;
    $('upload-label-text').textContent = references.length ? 'Add more images' : 'Add images';
  }
  async function readImage(file, maxEdge) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(`${file.name}: use a PNG, JPG or WebP image.`);
    if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: the image is larger than 25 MB.`);
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
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`${file.name}: could not prepare this image.`);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      let dataUrl = canvas.toDataURL('image/png');
      // The server accepts up to 10 MB per image. Large photos fall back to high-quality JPEG.
      if (dataUrl.length > 13_000_000) dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      if (dataUrl.length > 13_000_000) throw new Error(`${file.name}: this image is too detailed to send. Try a smaller copy.`);
      return { name: file.name, dataUrl, width: canvas.width, height: canvas.height };
    } finally {
      URL.revokeObjectURL(objectUrl);
      img.src = '';
      canvas.width = canvas.height = 0;
    }
  }
  const readReference = (file) => readImage(file, 1024);
  async function fileFromResult(item) {
    const response = await fetch(localUrl(item.url), { cache: 'no-store' });
    if (!response.ok) throw new Error('The image could not be opened.');
    return new File([await response.blob()], item.filename || 'image.png', { type: 'image/png' });
  }
  function setStartImage(image) {
    startImage = image;
    clearMask();
    useMatchingShape();
    renderInputs();
    updateControls();
  }
  function clearMask() {
    maskCanvas = null;
    maskDataUrl = '';
    const overlay = $('start-mask-overlay');
    overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
    renderInputs();
  }
  function drawMaskThumbnail() {
    const overlay = $('start-mask-overlay');
    if (!startImage) return;
    overlay.width = startImage.width;
    overlay.height = startImage.height;
    const context = overlay.getContext('2d');
    context.clearRect(0, 0, overlay.width, overlay.height);
    if (maskCanvas) context.drawImage(maskCanvas, 0, 0);
  }

  // Mask painter: strokes are drawn in a tint on a canvas the size of the start image copy, then exported as
  // white (redraw) on black (keep), which is the mask format sd-cli expects.
  const maskEditor = { drawing: false, last: null, history: [] };
  // Undo keeps the last 10 states (a 1536 px mask is about 9 MB each).
  function rememberMask() {
    const canvas = $('mask-canvas');
    maskEditor.history.push(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
    if (maskEditor.history.length > 10) maskEditor.history.shift();
    $('mask-undo').disabled = false;
  }
  function undoMask() {
    const previous = maskEditor.history.pop();
    if (previous) $('mask-canvas').getContext('2d').putImageData(previous, 0, 0);
    $('mask-undo').disabled = !maskEditor.history.length;
  }
  function brushRadius() {
    const canvas = $('mask-canvas');
    return Math.max(2, Number($('brush-size').value) / 100 * Math.max(canvas.width, canvas.height) / 2);
  }
  function maskPoint(event) {
    const canvas = $('mask-canvas');
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  }
  function paintStroke(from, to) {
    const context = $('mask-canvas').getContext('2d');
    context.globalCompositeOperation = brush === 'erase' ? 'destination-out' : 'source-over';
    context.strokeStyle = MASK_COLOR;
    context.lineWidth = brushRadius() * 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.globalCompositeOperation = 'source-over';
  }
  function moveBrushRing(event) {
    const canvas = $('mask-canvas');
    const rect = canvas.getBoundingClientRect();
    let ring = $('mask-frame').querySelector('.brush-ring');
    if (!ring) { ring = el('span', 'brush-ring'); $('mask-frame').append(ring); }
    const size = brushRadius() * 2 * rect.width / canvas.width;
    ring.style.width = ring.style.height = `${size}px`;
    ring.style.left = `${event.clientX - rect.left}px`;
    ring.style.top = `${event.clientY - rect.top}px`;
    ring.hidden = false;
  }
  function openMaskEditor() {
    if (!startImage || isBusy()) return;
    const canvas = $('mask-canvas');
    canvas.width = startImage.width;
    canvas.height = startImage.height;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (maskCanvas) context.drawImage(maskCanvas, 0, 0);
    $('mask-image').src = startImage.dataUrl;
    maskEditor.history = [];
    $('mask-undo').disabled = true;
    setBrush('paint');
    $('mask-dialog').showModal();
  }
  function setBrush(value) {
    brush = value;
    document.querySelectorAll('[data-brush]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.brush === value);
      button.setAttribute('aria-pressed', String(button.dataset.brush === value));
    });
  }
  function saveMask() {
    const canvas = $('mask-canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = false;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 127) { painted = true; break; }
    if (!painted) { clearMask(); $('mask-dialog').close(); updateControls(); return; }
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    maskCanvas.getContext('2d').drawImage(canvas, 0, 0);
    const white = document.createElement('canvas');
    white.width = canvas.width;
    white.height = canvas.height;
    const whiteContext = white.getContext('2d');
    whiteContext.drawImage(canvas, 0, 0);
    whiteContext.globalCompositeOperation = 'source-in';
    whiteContext.fillStyle = '#fff';
    whiteContext.fillRect(0, 0, white.width, white.height);
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const outContext = out.getContext('2d');
    outContext.fillStyle = '#000';
    outContext.fillRect(0, 0, out.width, out.height);
    outContext.drawImage(white, 0, 0);
    maskDataUrl = out.toDataURL('image/png');
    drawMaskThumbnail();
    $('mask-dialog').close();
    renderInputs();
    updateControls();
  }

  function updateControls() {
    const busy = isBusy();
    const off = busy || stopped;
    const generating = isGenerating();
    const cancellable = generating || isEnhancing();
    const model = getModel();
    document.querySelectorAll('#generate-form input, #generate-form select, #generate-form textarea, #generate-form button:not(.info-button):not(#generate):not(#cancel)').forEach((control) => { control.disabled = off; });
    const blank = $('blank-prompt').checked;
    if (blank) $('transparent').checked = false;
    $('prompt').disabled = off || blank;
    $('prompt').required = false;
    $('transparent').disabled = off || blank;
    $('steps').disabled = off || turbo();
    const guided = Number($('cfg').value) > 1;
    $('negative-prompt').disabled = off || blank || !guided;
    $('negative-prompt').placeholder = blank ? 'Off while Blank prompt is on' : guided ? 'Optional — for example: blurry, text, watermark' : 'Set Guidance above 1 to use';
    $('reference-files').disabled = off || references.length >= maxReferences();
    $('upload-label').classList.toggle('disabled', $('reference-files').disabled);
    $('start-label').classList.toggle('disabled', $('start-file').disabled);
    $('enhance').disabled = off || !connected || blank || !$('prompt').value.trim();
    $('enhance').textContent = isEnhancing() ? 'Expanding…' : 'Expand prompt';
    $('open-loras').disabled = stopped || !connected || !model;
    document.querySelectorAll('[data-format]').forEach((button) => { button.disabled = off; });
    document.querySelectorAll('[data-model-id]').forEach((button) => {
      const found = state?.models?.find((item) => item.id === button.dataset.modelId);
      button.disabled = off || !found?.ready;
    });
    const tooLarge = $('hires').checked && (hiresSize().width > maxSize() || hiresSize().height > maxSize());
    $('generate').hidden = cancellable;
    $('generate').disabled = !connected || stopped || busy || !model?.ready || references.length > maxReferences() || tooLarge;
    $('cancel').hidden = !cancellable;
    $('cancel').disabled = cancelling || submitting || stopped || !connected;
    $('cancel').textContent = cancelling ? 'Cancelling…' : submitting ? 'Starting…' : isEnhancing() ? 'Cancel expansion' : 'Cancel generation';
    const count = Number($('batch').value) || 1;
    $('generate-label').textContent = !model?.ready && state ? 'Waiting for model files' : count > 1 ? `Generate ${count} images` : 'Generate image';
    $('generate-hint').textContent = generating ? 'The first image may take longer while the model loads.' : isEnhancing() ? 'Expanding locally…' : state?.busy ? 'The local server is working…' : tooLarge ? `The upscaled size must stay within ${maxSize()} px` : references.length > maxReferences() ? `Remove ${references.length - maxReferences()} reference image(s) to continue` : startImage && maskDataUrl ? 'Redraws the painted area · Ctrl + Enter to generate' : startImage ? 'Redraws the start image · Ctrl + Enter to generate' : !blank && !$('prompt').value.trim() ? 'Empty description makes a random image · Ctrl + Enter' : 'Ctrl + Enter to generate';
    $('reuse').disabled = off || !selectedImage;
    $('use-start').disabled = off || !selectedImage || !options().startImage;
    $('upscale-image').disabled = off || !selectedImage || Number(selectedImage.width) > 2048 || Number(selectedImage.height) > 2048;
    $('use-reference').disabled = off || !selectedImage || !model?.capabilities?.editing || references.length >= maxReferences();
    $('shutdown').disabled = busy || stopped || !connected;
    $('open-outputs').disabled = stopped || !connected;
  }

  // ---- Results ----
  function updateJobVisibility() {
    const job = state?.job;
    const otherImage = job?.status === 'complete' && selectedImage && job.result?.filename && selectedImage.filename !== job.result.filename && !job.results?.some((item) => item.filename === selectedImage.filename);
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
    if (item.mode === 'inpaint') specs.push('Masked redraw');
    else if (item.mode === 'redraw') specs.push(`Redraw ${Number(item.strength).toFixed(2)}`);
    if (item.mode === 'upscale') specs.push('4× upscale');
    else if (item.hires || item.postUpscale) specs.push('Upscaled');
    if (item.loras?.length) specs.push(`${item.loras.length} LoRA${item.loras.length === 1 ? '' : 's'}`);
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
  function renderLivePreview() {
    const url = isActive() ? localUrl(state?.job?.preview) : '';
    if (!url) {
      livePreviewUrl = '';
      $('live-preview-image').hidden = true;
      $('live-preview-label').hidden = true;
      if (!selectedImage) { $('empty-state').hidden = false; $('preview-stage').classList.remove('has-image'); }
      return;
    }
    if (url === livePreviewUrl) return;
    livePreviewUrl = url;
    const loader = new Image();
    loader.onload = () => {
      if (livePreviewUrl !== url) return;
      $('live-preview-image').src = url;
      $('live-preview-image').hidden = false;
      $('live-preview-label').hidden = false;
      $('empty-state').hidden = true;
      $('preview-stage').classList.add('has-image');
    };
    loader.src = url;
  }
  function renderJob() {
    const job = state?.job;
    const panel = $('job-status');
    renderLivePreview();
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
    $('job-phase').textContent = job.mode === 'upscale' && active ? 'Upscaling image' : phaseLabels[job.status] === 'Image saved' && job.results?.length > 1 ? `${job.results.length} images saved` : phaseLabels[job.status] || 'Working';
    $('job-elapsed').textContent = job.elapsedMs === undefined || job.elapsedMs === null ? '' : duration(job.elapsedMs);
    let message = job.status === 'error' ? job.error || job.message || 'Generation failed. Check the launcher window for more details.' : job.message || '';
    if (job.warning && !active) message = [message, job.warning].filter(Boolean).join('\n');
    const repeatsCompletion = job.status === 'complete' && message.trim().replace(/[.!]+$/, '').toLowerCase() === $('job-phase').textContent.toLowerCase();
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
    renderInputs();
    renderSettings();
    renderLoras();
    renderUpscalers();
    renderDownload();
    renderGallery();
    renderJob();
    updateDimensions();
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
    // An empty description is sent as Blank prompt (the server uses the Braille blank U+2800).
    const blankPrompt = $('blank-prompt').checked || !$('prompt').value.trim();
    const prompt = blankPrompt ? '' : $('prompt').value.trim();
    if (references.length > maxReferences()) { showError(`This model accepts up to ${maxReferences()} reference images.`); return; }
    // A hidden field the browser considers invalid (say Extra noise 0.33 before switching sampler) would block the
    // form without showing why. Hidden fields are not sent, so reset them to their defaults.
    document.querySelectorAll('#generate-form input').forEach((input) => { if (!input.checkValidity() && input.closest('[hidden]')) input.value = input.defaultValue; });
    if (!$('generate-form').reportValidity()) return;
    showError('');
    submitting = true;
    updateControls();
    const cfg = Number($('cfg').value);
    const optional = (id) => $(id).value.trim() === '' ? null : Number($(id).value);
    try {
      const response = await post('/api/generate', {
        modelId: selectedModelId, prompt, blankPrompt, ...dimensions(), seed: Number($('seed').value), steps: Number($('steps').value), cfg,
        negativePrompt: !blankPrompt && cfg > 1 ? $('negative-prompt').value.trim() : '',
        sampler: $('sampler').value, scheduler: $('scheduler').value,
        eta: $('eta-field').hidden ? null : optional('eta'), flowShift: $('shift-field').hidden ? null : optional('flow-shift'),
        batch: Number($('batch').value) || 1, tiling: $('tiling').value, cache: $('cache').value, preview: $('live-preview').checked,
        hires: { enabled: $('hires').checked, scale: Number($('hires-scale').value), strength: Number($('hires-strength').value), steps: Number($('hires-steps').value) || 0, upscaler: $('hires-upscaler').value },
        loras: selectedLoras(),
        postUpscale: $('post-upscale').value || null,
        references: references.map(({ name, dataUrl }) => ({ name, dataUrl })),
        initImage: startImage ? { name: startImage.name, dataUrl: startImage.dataUrl } : null,
        mask: startImage && maskDataUrl ? { name: 'mask.png', dataUrl: maskDataUrl } : null,
        strength: Number($('strength').value),
        transparent: !blankPrompt && Boolean(options().transparent) && $('transparent').checked,
      }, 60000);
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
  ['resolution', 'aspect', 'custom-width', 'custom-height', 'hires-scale'].forEach((id) => $(id).addEventListener('input', () => { updateDimensions(); updateControls(); }));
  $('aspect').addEventListener('change', () => {
    if ($('aspect').value === 'custom') { const { width, height } = dimensions(); $('custom-width').value = width; $('custom-height').value = height; }
    updateDimensions();
  });
  ['custom-width', 'custom-height'].forEach((id) => $(id).addEventListener('change', () => { $(id).value = round32(Number($(id).value) || 768); updateDimensions(); }));
  $('batch').addEventListener('change', updateControls);
  $('cfg').addEventListener('input', updateControls);
  $('sampler').addEventListener('change', renderSettings);
  $('scheduler').addEventListener('change', () => {
    if (!turbo() && Number($('steps').value) === 8 && getModel()?.options?.turboSchedule) $('steps').value = 12;
    renderSettings();
    updateControls();
  });
  $('post-upscale').addEventListener('change', () => { updateDimensions(); updateControls(); });
  $('upscale-image').addEventListener('click', async () => {
    if (isBusy() || !selectedImage) return;
    showError('');
    submitting = true;
    updateControls();
    try {
      const response = await post('/api/upscale', { name: selectedImage.filename, upscaler: $('post-upscale').value || state?.upscalers?.[0]?.file }, 60000);
      if (response.job && state) state.job = response.job;
      render();
    } catch (error) { toast(`Could not upscale: ${error.message}`, true); }
    finally { submitting = false; updateControls(); clearTimeout(pollTimer); poll(); }
  });
  $('hires').addEventListener('change', () => { renderSettings(); updateDimensions(); updateControls(); });
  $('strength').addEventListener('input', syncRanges);
  $('hires-strength').addEventListener('input', syncRanges);
  $('reference-files').addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    addReferenceFiles(files);
  });
  // Shared by the file picker, paste and drag-and-drop.
  async function addReferenceFiles(files) {
    if (isBusy() || stopped || !files.length) return;
    uploading = true;
    showError('');
    updateControls();
    const errors = [];
    const hadInput = Boolean(inputShape());
    try {
      for (const file of files) {
        if (references.length >= maxReferences()) { errors.push(`This model accepts up to ${maxReferences()} reference images.`); break; }
        try { references.push(await readReference(file)); }
        catch (error) { errors.push(error.message); }
      }
    } finally {
      uploading = false;
      renderReferences();
      renderInputs();
      if (!hadInput) useMatchingShape(); else updateDimensions();
      updateControls();
      if (errors.length) showError(errors.join('\n'));
    }
  }
  $('start-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setStartFile(file);
  });
  async function setStartFile(file) {
    if (isBusy() || stopped || !file) return;
    uploading = true;
    showError('');
    updateControls();
    try { setStartImageFromRead(await readImage(file, 1536)); }
    catch (error) { showError(error.message); }
    finally { uploading = false; updateControls(); }
  }
  // Drop images on the reference or start image section, or paste one (Ctrl+V) anywhere on the page.
  // A paste goes to the references, or to the start image when the model takes no references.
  const imageFiles = (list) => Array.from(list || []).filter((file) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
  [['reference-section', addReferenceFiles], ['start-section', (files) => setStartFile(files[0])]].forEach(([id, accept]) => {
    const section = $(id);
    section.addEventListener('dragover', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = isBusy() ? 'none' : 'copy';
      section.classList.add('drop-target');
    });
    section.addEventListener('dragleave', (event) => { if (!section.contains(event.relatedTarget)) section.classList.remove('drop-target'); });
    section.addEventListener('drop', (event) => {
      event.preventDefault();
      section.classList.remove('drop-target');
      const files = imageFiles(event.dataTransfer?.files);
      if (files.length) accept(files);
      else showError('Drop PNG, JPG or WebP images.');
    });
  });
  document.addEventListener('paste', (event) => {
    const files = imageFiles(Array.from(event.clipboardData?.items || []).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean));
    if (!files.length || $('mask-dialog').open || $('shutdown-dialog').open) return;
    event.preventDefault();
    if (getModel()?.capabilities?.editing && references.length < maxReferences()) addReferenceFiles(files.map((file, index) => new File([file], file.name && file.name !== 'image.png' ? file.name : `Pasted image ${references.length + index + 1}.png`, { type: file.type })));
    else if (options().startImage && !startImage) setStartFile(files[0]);
    else showError(`This model accepts up to ${maxReferences()} reference images.`);
  });
  function setStartImageFromRead(image) {
    $('start-preview').src = image.dataUrl;
    setStartImage(image);
  }
  $('remove-start').addEventListener('click', () => { if (isBusy()) return; startImage = null; clearMask(); $('start-preview').removeAttribute('src'); if ($('aspect').value === 'match' && !inputShape()) $('aspect').value = '1:1'; updateDimensions(); renderInputs(); updateControls(); });
  $('paint-mask').addEventListener('click', openMaskEditor);
  $('clear-mask').addEventListener('click', () => { if (!isBusy()) { clearMask(); updateControls(); } });
  $('use-start').addEventListener('click', async () => {
    if (isBusy() || !selectedImage) return;
    try { setStartImageFromRead(await readImage(await fileFromResult(selectedImage), 1536)); toast('Image set as the start image. Describe the finished picture, or paint a mask.'); $('start-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    catch (error) { toast(error.message, true); }
  });
  $('use-reference').addEventListener('click', async () => {
    if (isBusy() || !selectedImage || references.length >= maxReferences()) return;
    const hadInput = Boolean(inputShape());
    try {
      references.push(await readReference(await fileFromResult(selectedImage)));
      renderReferences(); renderInputs();
      if (!hadInput) useMatchingShape(); else updateDimensions();
      updateControls();
      toast(`Added as reference image ${references.length}.`);
    } catch (error) { toast(error.message, true); }
  });
  const maskCanvasElement = $('mask-canvas');
  maskCanvasElement.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    rememberMask();
    maskCanvasElement.setPointerCapture(event.pointerId);
    maskEditor.drawing = true;
    maskEditor.last = maskPoint(event);
    paintStroke(maskEditor.last, maskEditor.last);
  });
  maskCanvasElement.addEventListener('pointermove', (event) => {
    moveBrushRing(event);
    if (!maskEditor.drawing) return;
    const point = maskPoint(event);
    paintStroke(maskEditor.last, point);
    maskEditor.last = point;
  });
  ['pointerup', 'pointercancel'].forEach((type) => maskCanvasElement.addEventListener(type, () => { maskEditor.drawing = false; }));
  maskCanvasElement.addEventListener('pointerleave', () => { const ring = $('mask-frame').querySelector('.brush-ring'); if (ring) ring.hidden = true; });
  document.querySelectorAll('[data-brush]').forEach((button) => button.addEventListener('click', () => setBrush(button.dataset.brush)));
  $('mask-fill').addEventListener('click', () => { rememberMask(); const canvas = $('mask-canvas'); const context = canvas.getContext('2d'); context.fillStyle = MASK_COLOR; context.fillRect(0, 0, canvas.width, canvas.height); });
  $('mask-clear').addEventListener('click', () => { rememberMask(); const canvas = $('mask-canvas'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); });
  $('mask-undo').addEventListener('click', undoMask);
  $('mask-invert').addEventListener('click', () => {
    rememberMask();
    const canvas = $('mask-canvas');
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    const context = canvas.getContext('2d');
    context.fillStyle = MASK_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'destination-out';
    context.drawImage(copy, 0, 0);
    context.globalCompositeOperation = 'source-over';
  });
  $('mask-cancel').addEventListener('click', () => $('mask-dialog').close());
  $('mask-save').addEventListener('click', saveMask);
  $('open-loras').addEventListener('click', async () => {
    try { await post('/api/open-loras', { modelId: selectedModelId }); }
    catch (error) { toast(`Could not open the LoRA folder: ${error.message}`, true); }
  });
  $('enhance').addEventListener('click', async () => {
    const prompt = $('prompt').value.trim();
    if (!prompt || $('blank-prompt').checked || isBusy() || !connected || references.length || !getModel()?.capabilities?.promptExpansion) return;
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
  document.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => { $('aspect').value = button.dataset.format; updateDimensions(); }));
  $('random-seed').addEventListener('click', () => {
    const current = Number($('seed').value);
    const random = new Uint32Array(1);
    let seed;
    do { seed = crypto.getRandomValues(random)[0] & 0x7fffffff; } while (seed === current);
    $('seed').value = String(seed);
  });
  $('reset-defaults').addEventListener('click', () => { restoreDefaults(); renderSettings(); updateControls(); toast('Model defaults restored.'); });
  $('reuse').addEventListener('click', () => {
    if (isBusy() || !selectedImage) return;
    const model = state?.models.find((item) => item.id === selectedImage.modelId && item.ready);
    if (model && model.id !== selectedModelId) selectModel(model.id);
    $('prompt').value = selectedImage.prompt || '';
    $('blank-prompt').checked = selectedImage.blankPrompt === true;
    if (selectedImage.negativePrompt) $('negative-prompt').value = selectedImage.negativePrompt;
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && $('mask-dialog').open) { event.preventDefault(); undoMask(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('generate').disabled && !$('shutdown-dialog').open && !$('mask-dialog').open) {
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
  syncRanges();
  updateDimensions();
  renderReferences();
  poll();
})();
