// Producers–Consumers visualization — robust per-entity timers, correct animation endpoints,
// buffer lock for sync mode, stable slot placement, strict inFlight handling.
// Updated: brighter pseudocode highlights, transfer-speed parameter (controls movement speed),
// and slightly larger buffer slots for improved readability.

// ---------- Screen switching ----------
function openSimulation(type) {
  const home = document.getElementById('home-screen');
  const sim = document.getElementById('simulation-screen');
  const title = document.getElementById('sim-title');

  home.style.display = 'none';
  sim.style.display = 'block';

  if (type === 'producerConsumer') {
    title.textContent = 'Producers–Consumers Visualization';
    resetProducerConsumer();
  } else {
    title.textContent = 'Coming soon: ' + type;
    clearMessages();
    addMessage('Only Producers–Consumers is implemented right now.');
  }
}

function goBackHome() {
  document.getElementById('simulation-screen').style.display = 'none';
  document.getElementById('home-screen').style.display = 'block';
  stopProducerConsumer();
}

// ---------- Global state ----------
const producerColors = [
  '#f97316', '#22c55e', '#3b82f6', '#eab308', '#ec4899',
  '#a855f7', '#06b6d4', '#f97373', '#4ade80', '#60a5fa'
];

let producers = [];
let consumers = [];
let buffer = [];
let bufferCapacity = 8;

let itemsCount = 0;
let writeIndex = 0;
let readIndex = 0;

let syncMode = 'sync';

let isRunning = false;
let isPaused = false;

let producerDelay = 800;
let consumerDelay = 1000;

let animationContainer = null;

// New: turn indices to enforce cyclic round-robin behavior
let nextProducerTurn = 0; // index into producers[]
let nextConsumerTurn = 0; // index into consumers[]

// NEW: Transfer speed multiplier (controls movement speed of items)
let transferSpeed = 1.0;

// ---------- Robust mutex + condition variables (for SYNC mode) ----------
class MutexWithConditions {
  constructor() {
    this.locked = false;
    this.waiters = []; // FIFO queue of { resolve, owner }
    this.conditions = new Map(); // Map<condName, Array<resumeFunction>>
    this.owner = null; // string like 'P1' or 'C2' while locked
  }

  tryAcquire(owner) {
    if (!this.locked) {
      this.locked = true;
      this.owner = owner || null;
      return true;
    }
    return false;
  }

  acquire(owner) {
    if (!this.locked) {
      this.locked = true;
      this.owner = owner || null;
      return Promise.resolve();
    }
    return new Promise((res) => {
      this.waiters.push({ res, owner });
    }).then(() => {
      this.locked = true;
      this.owner = owner || null;
    });
  }

  release() {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift();
      setTimeout(() => {
        try { next.res(); } catch (e) { console.error(e); }
      }, 0);
      // owner will be set when that acquire resolves
    } else {
      this.locked = false;
      this.owner = null;
    }
  }

  wait(condName, owner) {
    if (!this.conditions.has(condName)) this.conditions.set(condName, []);
    return new Promise((resolve) => {
      const resume = async () => {
        await this.acquire(owner);
        resolve();
      };
      this.conditions.get(condName).push(resume);
      this.release();
    });
  }

  notify(condName) {
    const q = this.conditions.get(condName);
    if (q && q.length > 0) {
      const resume = q.shift();
      setTimeout(() => resume(), 0);
    }
  }

  notifyAll(condName) {
    const q = this.conditions.get(condName);
    if (q && q.length > 0) {
      while (q.length > 0) {
        const resume = q.shift();
        setTimeout(() => resume(), 0);
      }
    }
  }
}

let bufferMutex = new MutexWithConditions();

// ---------- Read inputs ----------
function readPCInputs() {
  const capEl = document.getElementById('buffer-capacity');
  const prodCountEl = document.getElementById('num-producers');
  const consCountEl = document.getElementById('num-consumers');
  const prodDelayEl = document.getElementById('producer-delay');
  const consDelayEl = document.getElementById('consumer-delay');
  const modeEl = document.getElementById('sync-mode');
  const transferEl = document.getElementById('transfer-speed');

  const cap = parseInt(capEl && capEl.value, 10);
  const prodCount = parseInt(prodCountEl && prodCountEl.value, 10);
  const consCount = parseInt(consCountEl && consCountEl.value, 10);
  const prodDelay = parseInt(prodDelayEl && prodDelayEl.value, 10);
  const consDelay = parseInt(consDelayEl && consDelayEl.value, 10);
  const mode = modeEl && modeEl.value;

  bufferCapacity = isNaN(cap) ? 8 : Math.max(1, Math.min(20, cap));
  const producersNum = isNaN(prodCount) ? 1 : Math.max(1, Math.min(12, prodCount));
  const consumersNum = isNaN(consCount) ? 1 : Math.max(1, Math.min(12, consCount));

  producerDelay = isNaN(prodDelay) ? 800 : Math.max(50, prodDelay);
  consumerDelay = isNaN(consDelay) ? 1000 : Math.max(50, consDelay);

  syncMode = mode === 'nosync' ? 'nosync' : 'sync';

  // Read transfer speed (multiplier). Controls movement durations.
  if (transferEl) {
    const v = parseFloat(transferEl.value);
    if (!isNaN(v)) {
      transferSpeed = Math.max(0.1, Math.min(6.0, v));
    }
  }

  return { producersNum, consumersNum };
}

// ---------- Build UI entities ----------
function buildEntities(numProd, numCons) {
  const prodCol = document.getElementById('producers-column');
  const consCol = document.getElementById('consumers-column');
  prodCol.innerHTML = '';
  consCol.innerHTML = '';

  producers = [];
  consumers = [];

  for (let i = 0; i < numProd; i++) {
    const id = i + 1;
    const color = producerColors[i % producerColors.length];

    const el = document.createElement('div');
    el.classList.add('entity', 'producer');

    const shape = document.createElement('div');
    shape.classList.add('entity-shape');

    const label = document.createElement('div');
    label.classList.add('entity-label');
    label.textContent = `P${id} (0)`;

    const itemSpan = document.createElement('span');
    itemSpan.classList.add('entity-item');
    itemSpan.textContent = '';

    el.appendChild(shape);
    el.appendChild(label);
    el.appendChild(itemSpan);
    prodCol.appendChild(el);

    producers.push({
      id,
      color,
      count: 0,
      state: 'idle',
      hasItem: false,
      inFlight: false,
      el,
      shapeEl: shape,
      labelEl: label,
      itemEl: itemSpan,
      timer: null
    });
  }

  for (let j = 0; j < numCons; j++) {
    const id = j + 1;

    const el = document.createElement('div');
    el.classList.add('entity', 'consumer');

    const shape = document.createElement('div');
    shape.classList.add('entity-shape');

    const label = document.createElement('div');
    label.classList.add('entity-label');
    label.textContent = `C${id} (0)`;

    el.appendChild(shape);
    el.appendChild(label);
    consCol.appendChild(el);

    consumers.push({
      id,
      count: 0,
      state: 'idle',
      inFlight: false,
      el,
      shapeEl: shape,
      labelEl: label,
      timer: null
    });
  }

  if (!animationContainer) {
    animationContainer = document.createElement('div');
    animationContainer.id = 'animation-container';
    animationContainer.style.position = 'fixed';
    animationContainer.style.top = '0';
    animationContainer.style.left = '0';
    animationContainer.style.width = '100%';
    animationContainer.style.height = '100%';
    animationContainer.style.pointerEvents = 'none';
    animationContainer.style.zIndex = '10000';
    document.body.appendChild(animationContainer);
  }

  renderEntities();
  renderPseudocode();
}

// ---------- Start / Pause / Resume / Reset ----------
function startProducerConsumer() {
  if (isRunning) {
    addMessage('Simulation already running.');
    return;
  }

  const { producersNum, consumersNum } = readPCInputs();

  buffer = new Array(bufferCapacity).fill(null);
  itemsCount = 0;
  writeIndex = 0;
  readIndex = 0;

  buildEntities(producersNum, consumersNum);
  producers.forEach(p => {
    p.count = 0;
    p.hasItem = false;
    p.state = 'idle';
    p.inFlight = false;
    p.timer = null;
  });
  consumers.forEach(c => {
    c.count = 0;
    c.state = 'idle';
    c.inFlight = false;
    c.timer = null;
  });

  nextProducerTurn = 0;
  nextConsumerTurn = 0;

  updateCircularBuffer();

  isRunning = true;
  isPaused = false;

  bufferMutex = new MutexWithConditions();

  clearMessages();
  addMessage(
    `Started: ${producersNum} producer(s) @ ${producerDelay}ms, ${consumersNum} consumer(s) @ ${consumerDelay}ms, buffer=${bufferCapacity}, mode=${
      syncMode === 'sync' ? 'SYNC' : 'NO-SYNC'
    }, transferSpeed=${transferSpeed}`
  );

  requestAnimationFrame(() => {
    startEntityTimers();
  });
}

function pauseProducerConsumer() {
  if (!isRunning || isPaused) return;
  isPaused = true;
  addMessage('⏸ Paused');
}

function resumeProducerConsumer() {
  if (!isRunning || !isPaused) return;
  isPaused = false;
  addMessage('▶ Resumed');
}

function stopProducerConsumer() {
  producers.forEach(p => {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
  });
  consumers.forEach(c => {
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
  });

  bufferMutex = new MutexWithConditions();

  isRunning = false;
}

function resetProducerConsumer() {
  stopProducerConsumer();

  const { producersNum, consumersNum } = readPCInputs();

  buffer = new Array(bufferCapacity).fill(null);
  itemsCount = 0;
  writeIndex = 0;
  readIndex = 0;

  buildEntities(producersNum, consumersNum);
  producers.forEach(p => {
    p.count = 0;
    p.hasItem = false;
    p.state = 'idle';
    p.inFlight = false;
    p.timer = null;
  });
  consumers.forEach(c => {
    c.count = 0;
    c.state = 'idle';
    c.inFlight = false;
    c.timer = null;
  });

  nextProducerTurn = 0;
  nextConsumerTurn = 0;

  updateCircularBuffer();
  clearMessages();
  addMessage('🔄 Reset complete. Set parameters and press Start.');
}

// ---------- Entity timer management ----------
function startEntityTimers() {
  producers.forEach(p => {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
  });
  consumers.forEach(c => {
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
  });

  producers.forEach(p => {
    const initial = Math.floor(Math.random() * Math.min(150, Math.max(10, producerDelay / 4)));
    p.timer = setTimeout(function tickProducer() {
      if (isRunning) {
        if (!isPaused) {
          producerStep(p.id).catch(err => console.error(err));
        }
        p.timer = setTimeout(tickProducer, producerDelay + Math.floor(Math.random() * 80));
      }
    }, initial);
    console.debug(`Started timer for P${p.id}`);
  });

  consumers.forEach(c => {
    const initial = Math.floor(Math.random() * Math.min(150, Math.max(10, consumerDelay / 4)));
    c.timer = setTimeout(function tickConsumer() {
      if (isRunning) {
        if (!isPaused) {
          consumerStep(c.id).catch(err => console.error(err));
        }
        c.timer = setTimeout(tickConsumer, consumerDelay + Math.floor(Math.random() * 80));
      }
    }, initial);
    console.debug(`Started timer for C${c.id}`);
  });
}

// ---------- Speed changes ----------
function applySpeeds() {
  if (!isRunning) return;

  const prodDelay = parseInt(document.getElementById('producer-delay').value, 10);
  const consDelay = parseInt(document.getElementById('consumer-delay').value, 10);
  const transferEl = document.getElementById('transfer-speed');

  producerDelay = isNaN(prodDelay) ? 800 : Math.max(50, prodDelay);
  consumerDelay = isNaN(consDelay) ? 1000 : Math.max(50, consDelay);

  if (transferEl) {
    const v = parseFloat(transferEl.value);
    if (!isNaN(v)) transferSpeed = Math.max(0.1, Math.min(6.0, v));
  }

  startEntityTimers();

  updateCircularBuffer();

  addMessage(`⚡ Speed updated: producers=${producerDelay}ms, consumers=${consumerDelay}ms, transferSpeed=${transferSpeed}`);
}

let _applySpeedsTO = null;
document.addEventListener('input', (e) => {
  const id = e.target && e.target.id;

  if (isRunning && (id === 'producer-delay' || id === 'consumer-delay' || id === 'transfer-speed')) {
    if (_applySpeedsTO) clearTimeout(_applySpeedsTO);
    _applySpeedsTO = setTimeout(() => applySpeeds(), 300);
  }

  if (id === 'sync-mode') {
    syncMode = document.getElementById('sync-mode').value === 'nosync' ? 'nosync' : 'sync';

    if (isRunning) {
      if (syncMode === 'nosync') {
        producers.forEach(p => {
          if (p.inFlight || p.hasItem) p.state = 'producing';
          else p.state = 'idle';
        });
        consumers.forEach(c => {
          if (c.inFlight || itemsCount > 0) c.state = 'consuming';
          else c.state = 'idle';
        });
        renderEntities();
        addMessage('⚠ Switched to NO-SYNC mode (only producing/consuming states shown)');
      } else {
        addMessage('🔒 Switched to SYNC mode');
      }
    }
  }
});

// ---------- Helper functions ----------
function getProducerById(id) { return producers.find(p => p.id === id); }
function getConsumerById(id) { return consumers.find(c => c.id === id); }

// ---------- Geometry helpers (corrected alignment + larger slots) ----------
function computeSlotAbsoluteRect(container, centerX, centerY, size) {
  const crect = container.getBoundingClientRect();
  return {
    left: crect.left + centerX - size / 2,
    top: crect.top + centerY - size / 2,
    width: size,
    height: size
  };
}

function getSlotCenterAndRect(container, index, slotSize) {
  const crect = container.getBoundingClientRect();
  const width = container.clientWidth || crect.width;
  const height = container.clientHeight || crect.height;
  const centerX = width / 2;
  const centerY = height / 2;
  // leave margin so slots sit nicely inside the ring
  const radius = Math.max(28, Math.min(width, height) / 2 - 56);
  const angle = (2 * Math.PI * index) / bufferCapacity - Math.PI / 2;
  const x = centerX + radius * Math.cos(angle);
  const y = centerY + radius * Math.sin(angle);
  const absLeft = crect.left + x - slotSize / 2;
  const absTop = crect.top + y - slotSize / 2;
  return {
    localX: x,
    localY: y,
    rect: { left: absLeft, top: absTop, width: slotSize, height: slotSize }
  };
}

// helper to compute adjusted durations according to transferSpeed (controls movement)
function getAdjustedDuration(durationMs) {
  const speed = (transferSpeed && transferSpeed > 0) ? transferSpeed : 1.0;
  const d = Math.round(durationMs / speed);
  return Math.max(40, d);
}

// animate particle; uses getAdjustedDuration which is now controlled by transferSpeed
function animateItemTransferAbsolute(startX, startY, endX, endY, color, duration, onComplete) {
  const adjDuration = getAdjustedDuration(duration);

  const dx = endX - startX;
  const dy = endY - startY;
  const particle = document.createElement('div');

  particle.style.position = 'fixed';
  particle.style.left = `${startX}px`;
  particle.style.top = `${startY}px`;
  particle.style.width = '28px';
  particle.style.height = '28px';
  particle.style.borderRadius = '50%';
  particle.style.background = `${color}dd`;
  particle.style.border = `2px solid ${color}`;
  particle.style.boxShadow = `0 8px 24px ${color}55`;
  particle.style.zIndex = '10001';
  particle.style.display = 'flex';
  particle.style.alignItems = 'center';
  particle.style.justifyContent = 'center';
  particle.style.fontSize = '14px';
  particle.style.fontWeight = '700';
  particle.style.color = '#fff';
  particle.textContent = '★';
  particle.style.pointerEvents = 'none';

  particle.style.transform = 'translate3d(0,0,0) scale(0.92)';
  particle.style.willChange = 'transform, opacity';
  particle.style.transition = `transform ${adjDuration}ms cubic-bezier(0.215, 0.61, 0.355, 1), opacity ${Math.round(adjDuration * 0.85)}ms cubic-bezier(0.215, 0.61, 0.355, 1)`;
  particle.style.opacity = '1';

  animationContainer.appendChild(particle);

  requestAnimationFrame(() => {
    particle.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1)`;
    setTimeout(() => { particle.style.opacity = '0.96'; }, Math.round(adjDuration * 0.5));
  });

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try { particle.remove(); } catch (e) {}
    if (onComplete) onComplete();
  };

  const onTransEnd = (ev) => {
    if (ev.propertyName === 'transform') {
      cleanup();
      particle.removeEventListener('transitionend', onTransEnd);
    }
  };

  particle.addEventListener('transitionend', onTransEnd);
  setTimeout(() => cleanup(), adjDuration + 160);
}

function animateItemTransferAbsoluteAsync(startX, startY, endX, endY, color, duration) {
  return new Promise(resolve => {
    animateItemTransferAbsolute(startX, startY, endX, endY, color, duration, resolve);
  });
}

function animateItemTransfer(fromEl, toEl, color, onComplete) {
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();

  const startX = fromRect.left + fromRect.width / 2 - 14;
  const startY = fromRect.top + fromRect.height / 2 - 14;
  const endX = toRect.left + toRect.width / 2 - 14;
  const endY = toRect.top + toRect.height / 2 - 14;

  const distance = Math.hypot(endX - startX, endY - startY);
  const base = 420;
  const duration = Math.min(1800, Math.max(200, Math.round(base + distance * 0.5)));

  animateItemTransferAbsolute(startX, startY, endX, endY, color, duration, onComplete);
}

// ---------- Producer step ----------
async function producerStep(id) {
  const p = getProducerById(id);
  if (!p) return;

  if (isPaused) return;
  if (p.inFlight) return;

  if (producers.length > 0) {
    const currentIdx = nextProducerTurn % producers.length;
    const currentProducer = producers[currentIdx];
    if (!currentProducer || currentProducer.id !== id) {
      p.state = 'waiting-turn';
      renderEntities();
      return;
    }
  }

  p.inFlight = true;

  if (!p.hasItem) {
    p.state = 'producing';
    p.hasItem = true;
    renderEntities();
    addMessage(`🔨 P${id} produced item (turn P${id})`);
  }

  if (syncMode === 'sync') {
    await bufferMutex.acquire('P' + id);
    try {
      while (itemsCount >= bufferCapacity) {
        p.state = 'waiting';
        renderEntities();
        addMessage(`⏳ P${id} waiting (buffer full: ${itemsCount}/${bufferCapacity})`);
        await bufferMutex.wait('notFull', 'P' + id);
      }

      p.state = 'holding-lock';
      renderEntities();

      const container = document.getElementById('circular-buffer');
      const slotSize = 36; // slightly larger slots
      const slotData = getSlotCenterAndRect(container, writeIndex, slotSize);
      const slotRect = slotData.rect;

      // highlight pseudocode for holding-lock + upcoming buffer write
      updatePseudocodeHighlights();

      const sourceRect = p.shapeEl.getBoundingClientRect();
      const startX = sourceRect.left + sourceRect.width / 2 - 14;
      const startY = sourceRect.top + sourceRect.height / 2 - 14;
      const endX = slotRect.left + slotRect.width / 2 - 14;
      const endY = slotRect.top + slotRect.height / 2 - 14;

      const distance = Math.hypot(endX - startX, endY - startY);
      const base = 420;
      const duration = Math.min(1800, Math.max(200, Math.round(base + distance * 0.5)));

      await animateItemTransferAbsoluteAsync(startX, startY, endX, endY, p.color, duration);

      buffer[writeIndex] = { producerId: id };
      writeIndex = (writeIndex + 1) % bufferCapacity;
      itemsCount++;
      p.count++;
      p.hasItem = false;
      p.state = 'idle';
      p.inFlight = false;

      bufferMutex.notify('notEmpty');

      bufferMutex.release();

      if (producers.length > 0) {
        nextProducerTurn = (nextProducerTurn + 1) % producers.length;
        addMessage(`➡ Next producer turn: P${producers[nextProducerTurn].id}`);
      }

      renderEntities();
      updateCircularBuffer();
      addMessage(`✅ P${id} deposited [${itemsCount}/${bufferCapacity}] count=${p.count}`);
    } catch (err) {
      try { bufferMutex.release(); } catch (e) {}
      p.inFlight = false;
      p.state = 'idle';
      renderEntities();
      throw err;
    }
  } else {
    // NO-SYNC
    p.state = 'producing';
    renderEntities();

    const container = document.getElementById('circular-buffer');
    const slotSize = 36;
    const slotData = getSlotCenterAndRect(container, writeIndex, slotSize);
    const slotRect = slotData.rect;

    updatePseudocodeHighlights();

    const sourceRect = p.shapeEl.getBoundingClientRect();
    const startX = sourceRect.left + sourceRect.width / 2 - 14;
    const startY = sourceRect.top + sourceRect.height / 2 - 14;
    const endX = slotRect.left + slotRect.width / 2 - 14;
    const endY = slotRect.top + slotRect.height / 2 - 14;

    const distance = Math.hypot(endX - startX, endY - startY);
    const base = 420;
    const duration = Math.min(1800, Math.max(200, Math.round(base + distance * 0.5)));
    const prev = buffer[writeIndex];

    await animateItemTransferAbsoluteAsync(startX, startY, endX, endY, p.color, duration);

    buffer[writeIndex] = { producerId: id };
    writeIndex = (writeIndex + 1) % bufferCapacity;
    p.count++;
    if (prev === null) {
      itemsCount = Math.min(bufferCapacity, itemsCount + 1);
      addMessage(`📥 P${id} deposited [${itemsCount}/${bufferCapacity}] count=${p.count}`);
    } else {
      addMessage(`⚠️ RACE! P${id} overwrote P${prev.producerId}'s item`);
    }
    p.hasItem = false;
    p.state = 'idle';
    p.inFlight = false;

    if (producers.length > 0) {
      nextProducerTurn = (nextProducerTurn + 1) % producers.length;
      addMessage(`➡ Next producer turn: P${producers[nextProducerTurn].id}`);
    }

    renderEntities();
    updateCircularBuffer();
  }
}

// ---------- Consumer step ----------
async function consumerStep(id) {
  const c = getConsumerById(id);
  if (!c) return;

  if (isPaused) return;
  if (c.inFlight) return;

  if (consumers.length > 0) {
    const currentIdx = nextConsumerTurn % consumers.length;
    const currentConsumer = consumers[currentIdx];
    if (!currentConsumer || currentConsumer.id !== id) {
      c.state = 'waiting-turn';
      renderEntities();
      return;
    }
  }

  c.inFlight = true;

  if (syncMode === 'sync') {
    await bufferMutex.acquire('C' + id);
    try {
      while (itemsCount <= 0) {
        c.state = 'waiting';
        renderEntities();
        addMessage(`⏳ C${id} waiting (buffer empty)`);
        await bufferMutex.wait('notEmpty', 'C' + id);
      }

      c.state = 'holding-lock';
      renderEntities();

      const container = document.getElementById('circular-buffer');
      const slotSize = 36;
      const slotData = getSlotCenterAndRect(container, readIndex, slotSize);
      const slotRect = slotData.rect;

      // reflect pseudocode highlight for holding-lock + buffer read
      updatePseudocodeHighlights();

      const destRect = c.shapeEl.getBoundingClientRect();
      const startX = slotRect.left + slotRect.width / 2 - 14;
      const startY = slotRect.top + slotRect.height / 2 - 14;
      const endX = destRect.left + destRect.width / 2 - 14;
      const endY = destRect.top + destRect.height / 2 - 14;

      const item = buffer[readIndex];
      const color = item ? getProducerById(item.producerId)?.color || '#38bdf8' : '#38bdf8';

      const distance = Math.hypot(endX - startX, endY - startY);
      const base = 420;
      const duration = Math.min(1800, Math.max(200, Math.round(base + distance * 0.5)));

      await animateItemTransferAbsoluteAsync(startX, startY, endX, endY, color, duration);

      buffer[readIndex] = null;
      readIndex = (readIndex + 1) % bufferCapacity;
      itemsCount = Math.max(0, itemsCount - 1);
      c.count++;
      c.state = 'idle';
      c.inFlight = false;

      bufferMutex.notify('notFull');

      bufferMutex.release();

      if (consumers.length > 0) {
        nextConsumerTurn = (nextConsumerTurn + 1) % consumers.length;
        addMessage(`➡ Next consumer turn: C${consumers[nextConsumerTurn].id}`);
      }

      renderEntities();
      updateCircularBuffer();

      if (item) {
        addMessage(`✅ C${id} consumed from P${item.producerId} [${itemsCount}/${bufferCapacity}] count=${c.count}`);
      } else {
        addMessage(`✅ C${id} consumed [${itemsCount}/${bufferCapacity}] count=${c.count}`);
      }
    } catch (err) {
      try { bufferMutex.release(); } catch (e) {}
      c.inFlight = false;
      c.state = 'idle';
      renderEntities();
      throw err;
    }
  } else {
    // NO-SYNC
    c.state = 'consuming';
    renderEntities();

    const container = document.getElementById('circular-buffer');
    const slotSize = 36;
    const slotData = getSlotCenterAndRect(container, readIndex, slotSize);
    const slotRect = slotData.rect;

    updatePseudocodeHighlights();

    const destRect = c.shapeEl.getBoundingClientRect();
    const startX = slotRect.left + slotRect.width / 2 - 14;
    const startY = slotRect.top + slotRect.height / 2 - 14;
    const endX = destRect.left + destRect.width / 2 - 14;
    const endY = destRect.top + destRect.height / 2 - 14;

    const item = buffer[readIndex];
    const color = item ? getProducerById(item.producerId)?.color || '#38bdf8' : '#38bdf8';

    const distance = Math.hypot(endX - startX, endY - startY);
    const base = 420;
    const duration = Math.min(1800, Math.max(200, Math.round(base + distance * 0.5)));

    await animateItemTransferAbsoluteAsync(startX, startY, endX, endY, color, duration);

    if (item === null) addMessage(`⚠️ RACE! C${id} read empty slot`);
    else addMessage(`📤 C${id} consumed from P${item.producerId} count=${c.count + 1}`);

    buffer[readIndex] = null;
    readIndex = (readIndex + 1) % bufferCapacity;
    itemsCount = Math.max(0, itemsCount - 1);
    if (item) c.count++;
    c.state = 'idle';
    c.inFlight = false;

    if (consumers.length > 0) {
      nextConsumerTurn = (nextConsumerTurn + 1) % consumers.length;
      addMessage(`➡ Next consumer turn: C${consumers[nextConsumerTurn].id}`);
    }

    renderEntities();
    updateCircularBuffer();
  }
}

// ---------- Rendering ----------
function renderEntities() {
  const idleYellow = '#fbbf24';

  producers.forEach(p => {
    const s = p.shapeEl;
    s.className = 'entity-shape';
    s.style.cssText = '';

    if (p.state === 'idle') {
      s.style.borderColor = idleYellow;
      s.style.borderWidth = '3px';
      s.style.background = '#020617';
      s.style.color = idleYellow;
      s.style.boxShadow = 'none';
    } else if (p.state === 'producing') {
      const g = '#16a34a';
      s.style.borderColor = g;
      s.style.borderWidth = '3px';
      s.style.background = g;
      s.style.color = '#020617';
      s.style.boxShadow = `0 8px 22px ${g}66`;
    } else if (p.state === 'waiting') {
      s.style.borderColor = '#ffffff';
      s.style.borderWidth = '3px';
      s.style.background = '#ffffff';
      s.style.color = '#020617';
      s.style.boxShadow = '0 6px 20px #ffffff44';
    } else if (p.state === 'holding-lock') {
      s.style.borderColor = '#ffffff';
      s.style.borderWidth = '3px';
      s.style.background = '#ffffff';
      s.style.color = '#020617';
      s.style.boxShadow = '0 14px 36px #ffffff88';
    } else if (p.state === 'waiting-turn') {
      s.style.borderColor = '#94a3b8';
      s.style.borderWidth = '3px';
      s.style.background = '#020617';
      s.style.color = '#94a3b8';
      s.style.boxShadow = 'none';
    }

    p.labelEl.textContent = `P${p.id} (${p.count})`;
    p.itemEl.textContent = p.hasItem ? '★' : '';

    if (p.state === 'producing') {
      p.itemEl.style.color = '#020617';
    } else if (p.state === 'holding-lock') {
      p.itemEl.style.color = '#16a34a';
    } else {
      p.itemEl.style.color = p.color;
    }
  });

  consumers.forEach(c => {
    const s = c.shapeEl;
    s.className = 'entity-shape';
    s.style.cssText = '';

    if (c.state === 'idle') {
      s.style.borderColor = idleYellow;
      s.style.borderWidth = '3px';
      s.style.background = '#020617';
      s.style.color = idleYellow;
      s.style.boxShadow = 'none';
    } else if (c.state === 'consuming') {
      s.style.borderColor = '#38bdf8';
      s.style.borderWidth = '3px';
      s.style.background = '#020617';
      s.style.color = '#38bdf8';
      s.style.boxShadow = '0 8px 22px #38bdf888';
    } else if (c.state === 'waiting') {
      s.style.borderColor = '#ffffff';
      s.style.borderWidth = '3px';
      s.style.background = '#020617';
      s.style.color = '#ffffff';
      s.style.boxShadow = '0 6px 20px #ffffff44';
    } else if (c.state === 'holding-lock') {
      s.style.borderColor = '#38bdf8';
      s.style.borderWidth = '3px';
      s.style.background = '#071021';
      s.style.color = '#38bdf8';
      s.style.boxShadow = '0 12px 30px #38bdf899';
    } else if (c.state === 'waiting-turn') {
      s.style.borderColor = idleYellow;
      s.style.borderWidth = '3px';
      s.style.background = '#020617';
      s.style.color = idleYellow;
      s.style.boxShadow = 'none';
    }

    c.labelEl.textContent = `C${c.id} (${c.count})`;
  });

  // Update pseudocode highlights and metrics to reflect current state
  updatePseudocodeHighlights();
  updateMetrics();
}

function updateCircularBuffer() {
  const container = document.getElementById('circular-buffer');
  if (!container) return;

  container.style.position = 'relative';
  container.innerHTML = '';

  const width = container.clientWidth || container.getBoundingClientRect().width;
  const height = container.clientHeight || container.getBoundingClientRect().height;
  const slotCount = bufferCapacity;
  const slotSize = 36; // slightly larger slots

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(28, Math.min(width, height) / 2 - 56);

  // slot transition speed uses transferSpeed as well for consistency
  const slotTransMs = Math.max(30, Math.round(220 / (transferSpeed && transferSpeed > 0 ? transferSpeed : 1)));

  for (let i = 0; i < slotCount; i++) {
    const angle = (2 * Math.PI * i) / slotCount - Math.PI / 2;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    const slot = document.createElement('div');
    slot.classList.add('buffer-slot');
    // JS writes center coords; CSS transform centers the box
    slot.style.left = `${x}px`;
    slot.style.top = `${y}px`;
    slot.style.position = 'absolute';
    slot.style.width = `${slotSize}px`;
    slot.style.height = `${slotSize}px`;
    slot.style.display = 'flex';
    slot.style.alignItems = 'center';
    slot.style.justifyContent = 'center';
    slot.style.transition = `background ${slotTransMs}ms, box-shadow ${slotTransMs}ms`;

    const item = buffer[i];
    if (item !== null) {
      const prod = getProducerById(item.producerId);
      const color = prod ? prod.color : '#ffffff';
      slot.textContent = '★';
      slot.style.color = color;
      slot.style.borderColor = color;
      slot.style.background = `${color}33`;
    } else {
      slot.textContent = '';
      slot.style.borderColor = '#64748b';
      slot.style.background = 'transparent';
    }

    // stronger visual cues for head/tail
    if (i === writeIndex) slot.style.boxShadow = '0 0 14px 3px rgba(34,197,94,0.45)';
    if (i === readIndex && itemsCount > 0) slot.style.boxShadow = '0 0 14px 3px rgba(56,189,248,0.45)';

    container.appendChild(slot);
  }

  updateMetrics();
}

// ---------- Messages ----------
function addMessage(text) {
  const box = document.getElementById('message-area');
  if (!box) return;
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.textContent = `[${time}] ${text}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  while (box.children.length > 200) {
    box.removeChild(box.firstChild);
  }
}

function clearMessages() {
  const box = document.getElementById('message-area');
  if (!box) return;
  box.innerHTML = '';
}

// ---------- PSEUDOCODE PANEL (render + highlight) ----------
const sharedDataLines = [
  'Shared Data',
  'buffer[N]          ',
  'in = 0             ',
  'out = 0           ',
  'semaphore mutex = 1     ',
  'semaphore empty = N   ',
  'semaphore full = 0      '
];

const producerPseudoLinesSync = [
  'Producer Process',
  'Producer() {',
  'while (true) {',
  'item = produce_item()',
  'wait(empty)',
  'wait(mutex)',
  'buffer[in] = item',
  'in = (in + 1) % N',
  'signal(mutex)',
  'signal(full)',
  '}',
  '}'
];

const consumerPseudoLinesSync = [
  'Consumer Process',
  'Consumer() {',
  'while (true) {',
  'wait(full)',
  'wait(mutex)',
  'item = buffer[out]',
  'out = (out + 1) % N',
  'signal(mutex)',
  'signal(empty)',
  'consume_item(item)',
  '}',
  '}'
];

const producerPseudoLinesNoSync = [
  'Producer Process (unsync)',
  'Producer() {',
  'while (true) {',
  'item = produce_item()',
  'buffer[in] = item    // no synchronization',
  'in = (in + 1) % N',
  '}', 
  '}'
];

const consumerPseudoLinesNoSync = [
  'Consumer Process (unsync)',
  'Consumer() {',
  'while (true) {',
  'item = buffer[out]    // no synchronization',
  'out = (out + 1) % N',
  'consume_item(item)',
  '}',
  '}'
];

let producerPseudoLines = producerPseudoLinesSync;
let consumerPseudoLines = consumerPseudoLinesSync;

let pcodeMode = 'sync';

function renderPseudocode() {
  const shared = document.getElementById('shared-code');
  const prod = document.getElementById('producer-code');
  const cons = document.getElementById('consumer-code');
  if (!prod || !cons || !shared) return;

  if (pcodeMode === 'nosync') {
    producerPseudoLines = producerPseudoLinesNoSync;
    consumerPseudoLines = consumerPseudoLinesNoSync;
  } else {
    producerPseudoLines = producerPseudoLinesSync;
    consumerPseudoLines = consumerPseudoLinesSync;
  }

  const sharedHtmlParts = sharedDataLines.map((l, i) => {
    const escaped = escapeHtml(l);
    if (l.includes('in =')) {
      return `<div class="pseudo-line" id="shared-line-${i}">in = <span id="pseudo-in">${writeIndex}</span></div>`;
    } else if (l.includes('out =')) {
      return `<div class="pseudo-line" id="shared-line-${i}">out = <span id="pseudo-out">${readIndex}</span></div>`;
    } else if (l.toLowerCase().includes('semaphore empty')) {
      const emptyVal = Math.max(0, bufferCapacity - itemsCount);
      return `<div class="pseudo-line" id="shared-line-${i}">semaphore empty = <span id="pseudo-empty">${emptyVal}</span></div>`;
    } else if (l.toLowerCase().includes('semaphore full')) {
      return `<div class="pseudo-line" id="shared-line-${i}">semaphore full = <span id="pseudo-full">${itemsCount}</span></div>`;
    } else if (l.toLowerCase().includes('semaphore mutex')) {
      const owner = bufferMutex && bufferMutex.locked ? (bufferMutex.owner || 'locked') : 'free';
      return `<div class="pseudo-line" id="shared-line-${i}">semaphore mutex = <span id="pseudo-mutex">${escapeHtml(String(owner))}</span></div>`;
    } else {
      return `<div class="pseudo-line" id="shared-line-${i}">${escaped}</div>`;
    }
  });

  shared.innerHTML = sharedHtmlParts.join('');

  prod.innerHTML = producerPseudoLines.map((l, i) => `<div class="pseudo-line" id="prod-line-${i}">${escapeHtml(l)}</div>`).join('');
  cons.innerHTML = consumerPseudoLines.map((l, i) => `<div class="pseudo-line" id="cons-line-${i}">${escapeHtml(l)}</div>`).join('');

  updatePseudocodeValues();
}

function updatePseudocodeValues() {
  const elIn = document.getElementById('pseudo-in');
  const elOut = document.getElementById('pseudo-out');
  const elEmpty = document.getElementById('pseudo-empty');
  const elFull = document.getElementById('pseudo-full');
  const elMutex = document.getElementById('pseudo-mutex');

  if (elIn) elIn.textContent = String(writeIndex);
  if (elOut) elOut.textContent = String(readIndex);
  if (elEmpty) elEmpty.textContent = String(Math.max(0, bufferCapacity - itemsCount));
  if (elFull) elFull.textContent = String(itemsCount);
  if (elMutex) {
    const owner = bufferMutex && bufferMutex.locked ? (bufferMutex.owner || 'locked') : 'free';
    elMutex.textContent = String(owner);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Brighter, independent highlights for prod/cons/shared so they can appear simultaneously
function clearPseudoHighlights(block) {
  const removeClasses = ['highlight','prod-highlight','cons-highlight','shared-highlight'];
  if (!block) {
    const els = document.querySelectorAll('.pseudo-line');
    els.forEach(el => el.classList.remove(...removeClasses));
    return;
  }
  let selector = '.pseudo-line';
  if (block === 'prod') selector = '[id^="prod-line-"]';
  else if (block === 'cons') selector = '[id^="cons-line-"]';
  else if (block === 'shared') selector = '[id^="shared-line-"]';
  document.querySelectorAll(selector).forEach(el => el.classList.remove(...removeClasses));
}

function highlightLineByIdWithClass(id, cls) {
  const el = document.getElementById(id);
  if (el) el.classList.add('highlight', cls);
}

function highlightProducerLineBySubstring(substr) {
  const idx = findIndex(producerPseudoLines, substr);
  if (idx >= 0) {
    clearPseudoHighlights('prod');
    highlightLineByIdWithClass(`prod-line-${idx}`, 'prod-highlight');
  }
}

function highlightConsumerLineBySubstring(substr) {
  const idx = findIndex(consumerPseudoLines, substr);
  if (idx >= 0) {
    clearPseudoHighlights('cons');
    highlightLineByIdWithClass(`cons-line-${idx}`, 'cons-highlight');
  }
}

function highlightSharedLineBySubstring(substr) {
  const idx = findIndex(sharedDataLines, substr);
  if (idx >= 0) {
    clearPseudoHighlights('shared');
    highlightLineByIdWithClass(`shared-line-${idx}`, 'shared-highlight');
  }
}

function findIndex(lines, substring) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(substring)) return i;
  }
  return -1;
}

function updatePseudocodeHighlights() {
  // Producer highlight (independent)
  let activeProducer = producers.find(p => p.inFlight || (p.state && p.state !== 'idle' && p.state !== 'waiting-turn'));
  if (!activeProducer && producers.length > 0) activeProducer = producers[nextProducerTurn % producers.length];

  if (activeProducer) {
    switch (activeProducer.state) {
      case 'producing':
        highlightProducerLineBySubstring('item = produce_item');
        break;
      case 'holding-lock':
        highlightProducerLineBySubstring('buffer[in] = item');
        highlightSharedLineBySubstring('semaphore mutex');
        break;
      case 'waiting':
        highlightProducerLineBySubstring('wait(empty)');
        highlightSharedLineBySubstring('semaphore empty');
        break;
      case 'waiting-turn':
        highlightProducerLineBySubstring('Producer() {');
        break;
      case 'idle':
      default:
        if (pcodeMode === 'nosync') highlightProducerLineBySubstring('buffer[in] = item');
        else highlightProducerLineBySubstring('signal(full)');
        break;
    }
  } else {
    clearPseudoHighlights('prod');
  }

  // Consumer highlight (independent)
  let activeConsumer = consumers.find(c => c.inFlight || (c.state && c.state !== 'idle' && c.state !== 'waiting-turn'));
  if (!activeConsumer && consumers.length > 0) activeConsumer = consumers[nextConsumerTurn % consumers.length];

  if (activeConsumer) {
    switch (activeConsumer.state) {
      case 'consuming':
        highlightConsumerLineBySubstring('consume_item');
        break;
      case 'holding-lock':
        highlightConsumerLineBySubstring('item = buffer[out]');
        highlightSharedLineBySubstring('semaphore mutex');
        break;
      case 'waiting':
        highlightConsumerLineBySubstring('wait(full)');
        highlightSharedLineBySubstring('semaphore full');
        break;
      case 'waiting-turn':
        highlightConsumerLineBySubstring('Consumer() {');
        break;
      case 'idle':
      default:
        if (pcodeMode === 'nosync') highlightConsumerLineBySubstring('item = buffer[out]');
        else highlightConsumerLineBySubstring('signal(empty)');
        break;
    }
  } else {
    clearPseudoHighlights('cons');
  }
}

// ---------- Metrics updater ----------
function updateMetrics() {
  const elCap = document.getElementById('m-capacity');
  const elCount = document.getElementById('m-count');
  const elHead = document.getElementById('m-head');
  const elTail = document.getElementById('m-tail');
  const elWProds = document.getElementById('m-wprods');
  const elWCons = document.getElementById('m-wcons');
  const elOwner = document.getElementById('m-owner');

  if (elCap) elCap.textContent = String(bufferCapacity);
  if (elCount) elCount.textContent = String(itemsCount);
  if (elHead) elHead.textContent = String(readIndex);
  if (elTail) elTail.textContent = String(writeIndex);

  if (elWProds) {
    const wprods = producers.filter(p => p.state === 'waiting').length;
    elWProds.textContent = String(wprods);
  }
  if (elWCons) {
    const wcons = consumers.filter(c => c.state === 'waiting').length;
    elWCons.textContent = String(wcons);
  }

  if (elOwner) {
    const owner = bufferMutex && bufferMutex.locked ? (bufferMutex.owner || 'unknown') : 'free';
    elOwner.textContent = owner;
  }

  updatePseudocodeValues();
}

// ---------- Initialization ----------
document.addEventListener('DOMContentLoaded', () => {
  renderPseudocode();
  updateMetrics();

  const radios = document.querySelectorAll('input[name="pcode-mode"]');
  radios.forEach(r => {
    r.addEventListener('change', (e) => {
      pcodeMode = e.target.value === 'nosync' ? 'nosync' : 'sync';
      renderPseudocode();
      updatePseudocodeHighlights();
      updatePseudocodeValues();
    });
  });

  const transferEl = document.getElementById('transfer-speed');
  if (transferEl && (transferEl.value === '' || transferEl.value == null)) {
    transferEl.value = String(transferSpeed);
  }
});

// ---------- Utility: ensure pseudocode updates when entities change ----------
const origRenderEntities = renderEntities;
renderEntities = function() {
  origRenderEntities();
  renderPseudocode();
  updatePseudocodeHighlights();
  updateMetrics();
};

console.log('✅ public/app.js loaded — brighter pseudo highlights, transferSpeed control applied, larger slots.');