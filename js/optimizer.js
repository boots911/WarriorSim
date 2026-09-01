var SIM = SIM || {}

// Finds the best gear combinations buildable from items marked as owned ("in bags"),
// accounting for set bonuses, procs and on-use items. Strategy:
//   1. Every owned item is ranked by a single-swap sim against the currently equipped set.
//   2. Slots that can't interact across slots (no multi-piece set bonuses in their pool)
//      collapse to their best item; interacting slots (weapons, rings, trinkets, set
//      pieces) keep their top items plus every relevant set piece and are enumerated
//      exhaustively. Simple slots are widened with runner-ups while under the combo cap.
//   3. All candidate combos race through successive halving: everything is simmed at a low
//      iteration count, the bottom is cut, iterations quadruple, repeat. The finalists run
//      at the user's configured iteration count.
SIM.OPTIMIZER = {

    ARMOR_SLOTS: ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'ranged'],
    DISPLAY_SLOTS: ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet',
                    'finger1', 'finger2', 'trinket1', 'trinket2', 'ranged', 'mainhand', 'offhand', 'twohand'],
    MAX_COMBOS: 4000,
    HARD_MAX_COMBOS: 16000,
    FINAL_COUNT: 12,
    MARGINAL_ITERS: 1500,
    KEEP_INTERACTING: 2,   // non-set items kept in an interacting armor slot
    KEEP_PAIR: 4,          // rings/trinkets kept for pair building
    KEEP_MH: 4,
    KEEP_OH: 4,
    KEEP_TH: 3,

    init: function () {
        var view = this;
        view.body = $('body');
        view.section = view.body.find('section.optimizer');
        view.sidebar = view.body.find('section.sidebar');
        view.status = view.section.find('.opt-status');
        view.progress = view.section.find('.opt-progress-bar');
        view.results = view.section.find('.opt-results');
        view.running = false;
        view.events();
    },

    events: function () {
        var view = this;

        view.sidebar.find('.js-optimizer').click(function (e) {
            e.preventDefault();
            $(this).toggleClass('active');
            window.scrollTo(0, 0);
            view.section.css('min-height', view.body.outerHeight() + 'px');
            view.section.toggleClass('active');
            view.sidebar.find('.js-stats, .js-settings, .js-profiles').removeClass('active');
            $('section.stats, section.settings, section.profiles').removeClass('active');
            view.body.removeClass('sidebar-mobile-open');
        });

        view.section.find('.btn-close').click(function (e) {
            e.preventDefault();
            view.sidebar.find('.js-optimizer').removeClass('active');
            view.section.removeClass('active');
        });

        view.section.on('click', '.js-run-optimizer', function (e) {
            e.preventDefault();
            if (view.running) return;
            view.run();
        });

        view.section.on('click', '.js-cancel-optimizer', function (e) {
            e.preventDefault();
            view.cancel();
        });

        view.section.on('click', '.js-equip-set', function (e) {
            e.preventDefault();
            let index = $(this).data('index');
            if (view.finalists && view.finalists[index]) {
                view.equip(view.finalists[index].gearmap);
                SIM.UI.addAlert('Set equipped');
            }
        });

        view.section.on('click', '.opt-sources li', function (e) {
            e.preventDefault();
            $(this).addClass('active').siblings().removeClass('active');
        });

        view.section.on('click', '.js-run-finder', function (e) {
            e.preventDefault();
            if (view.running) return;
            const bucket = view.section.find('.opt-sources li.active').data('id');
            if (!bucket) { view.setFinderStatus('Pick a source first.'); return; }
            view.runFinder(bucket);
        });
    },

    // ---------- pools ----------

    ownedIds: function () {
        const owned = new Set();
        for (let type in gear)
            for (let item of gear[type])
                if (item.owned || item.selected) owned.add(String(item.id));
        return owned;
    },

    itemSlotIndex: function () {
        const index = {};
        for (let type in gear) {
            if (type == 'custom') continue;
            for (let item of gear[type]) {
                if (!index[item.id]) index[item.id] = { item: item, slots: [] };
                index[item.id].slots.push(type);
            }
        }
        return index;
    },

    currentGearMap: function () {
        const map = {};
        for (let type in gear) {
            if (type == 'custom') continue;
            const selected = gear[type].filter(i => i.selected).map(i => i.id);
            if (selected.length) map[type] = selected;
        }
        return map;
    },

    // ids of pieces belonging to sets with 2+ owned pieces (these make cross-slot tradeoffs)
    multiSetPieceIds: function (owned) {
        const ids = new Set();
        for (let set of sets) {
            const ownedPieces = set.items.filter(id => owned.has(String(id)));
            if (ownedPieces.length < 2) continue;
            for (let id of ownedPieces) ids.add(String(id));
        }
        return ids;
    },

    buildPools: function () {
        const view = this;
        const owned = view.ownedIds();
        const pools = {};
        const inPool = (type) => gear[type].filter(i => owned.has(String(i.id)));

        for (let slot of view.ARMOR_SLOTS) pools[slot] = inPool(slot);
        pools.finger = inPool('finger1');
        pools.trinket = inPool('trinket1');
        pools.twohand = inPool('twohand');
        pools.mainhand = inPool('mainhand');

        // shields only matter for shield-stance builds, mirror the gear table rule
        const shieldstance = buffs.some(b => b.active && b.id == 71);
        pools.offhand = inPool('offhand').filter(i => shieldstance ? i.type == 'Shield' : i.type != 'Shield');

        return pools;
    },

    weaponOptions: function (mhPool, ohPool, thPool) {
        const options = [];
        for (let th of thPool)
            options.push([null, null, th.id]);
        for (let mh of mhPool) {
            options.push([mh.id, null, null]);
            for (let oh of ohPool) {
                if (String(oh.id) == String(mh.id)) continue;
                options.push([mh.id, oh.id, null]);
            }
        }
        return options;
    },

    pairOptions: function (pool) {
        const options = [];
        if (pool.length == 0) return options;
        if (pool.length == 1) return [[pool[0].id, null]];
        for (let i = 0; i < pool.length; i++)
            for (let j = i + 1; j < pool.length; j++)
                options.push([pool[i].id, pool[j].id]);
        return options;
    },

    enumerate: function (groups) {
        const combos = [];
        const idx = new Array(groups.length).fill(0);
        while (true) {
            const gearmap = {};
            for (let gi = 0; gi < groups.length; gi++) {
                const g = groups[gi];
                const opt = g.options[idx[gi]];
                for (let si = 0; si < g.slots.length; si++)
                    gearmap[g.slots[si]] = [opt[si]];
            }
            combos.push({ gearmap });
            let gi = 0;
            while (gi < groups.length) {
                idx[gi]++;
                if (idx[gi] < groups[gi].options.length) break;
                idx[gi] = 0;
                gi++;
            }
            if (gi >= groups.length) break;
        }
        return combos;
    },

    comboCount: function (groups) {
        return groups.reduce((p, g) => p * g.options.length, 1);
    },

    // ---------- worker pool ----------

    pool: function () {
        const view = this;
        if (view._pool) return view._pool;
        view._pool = {
            workers: [],
            worker(i) {
                if (!this.workers[i]) this.workers[i] = new Worker('./dist/js/sim-worker.min.js');
                return this.workers[i];
            },
            runBatch(combos, iterations, playerConfig, simConfig, onProgress) {
                const globals = getGlobalsDelta();
                const threads = Math.min(MAX_WORKERS, combos.length);
                const per = Math.ceil(combos.length / threads);
                const chunks = [];
                for (let i = 0; i < combos.length; i += per) chunks.push(combos.slice(i, i + per));
                const progress = new Array(chunks.length).fill(0);
                const report = () => { if (onProgress) onProgress(progress.reduce((a, b) => a + b, 0), combos.length); };
                const promises = chunks.map((chunk, ci) => new Promise((resolve, reject) => {
                    const w = this.worker(ci);
                    w.onerror = (err) => reject(err.message || 'Worker error');
                    w.onmessage = (event) => {
                        const [type, ...args] = event.data;
                        if (type === TYPE.UPDATE) {
                            progress[ci] = args[0];
                            report();
                        } else if (type === TYPE.FINISHED) {
                            progress[ci] = chunk.length;
                            report();
                            resolve(args[0]);
                        } else {
                            reject('Unexpected worker message');
                        }
                    };
                    w.postMessage({
                        globals,
                        playerConfig,
                        sim: simConfig,
                        batch: chunk.map(c => ({ gearmap: c.gearmap, iterations })),
                    });
                }));
                return Promise.all(promises).then(chunkResults => {
                    const out = [];
                    for (const r of chunkResults) out.push(...r);
                    return out;
                });
            },
            terminate() {
                for (const w of this.workers) if (w) w.terminate();
                this.workers = [];
            },
        };
        return view._pool;
    },

    cancel: function () {
        const view = this;
        if (!view.running) return;
        view.cancelled = true;
        if (view._pool) { view._pool.terminate(); view._pool = null; }
        if (view._cancelReject) view._cancelReject('cancelled');
    },

    batch: function (combos, iterations, onProgress) {
        const view = this;
        const cancelPromise = new Promise((resolve, reject) => { view._cancelReject = reject; });
        return Promise.race([
            view.pool().runBatch(combos, iterations, view.playerConfig, view.simConfig, onProgress),
            cancelPromise,
        ]);
    },

    setStatus: function (msg) {
        this.status.text(msg);
    },

    setProgress: function (done, total) {
        this.progress.css('width', total ? (100 * done / total) + '%' : '0%');
    },

    // ---------- marginal ranking ----------

    // Sim every owned item as a single swap into the current set, so pools can be pruned
    // by how much each item contributes on its own.
    rankPools: async function (pools, baseline) {
        const view = this;
        const jobs = [];
        const addJob = (key, id, gearmap) => jobs.push({ key, id, combo: { gearmap } });

        for (let slot of view.ARMOR_SLOTS)
            if (pools[slot].length > 1)
                for (const item of pools[slot])
                    addJob(slot, item.id, Object.assign({}, baseline, { [slot]: [item.id] }));

        if (pools.finger.length > 2)
            for (const item of pools.finger)
                addJob('finger', item.id, Object.assign({}, baseline, { finger1: [item.id], finger2: [null] }));

        if (pools.trinket.length > 2)
            for (const item of pools.trinket)
                addJob('trinket', item.id, Object.assign({}, baseline, { trinket1: [item.id], trinket2: [null] }));

        const baseMH = (baseline.mainhand || [null])[0];
        const baseOH = (baseline.offhand || [null])[0];
        if (pools.mainhand.length > view.KEEP_MH)
            for (const item of pools.mainhand)
                addJob('mainhand', item.id, Object.assign({}, baseline, {
                    mainhand: [item.id], twohand: [null],
                    offhand: [String(baseOH) == String(item.id) ? null : baseOH],
                }));
        if (pools.offhand.length > view.KEEP_OH)
            for (const item of pools.offhand)
                addJob('offhand', item.id, Object.assign({}, baseline, {
                    offhand: [item.id], twohand: [null],
                    mainhand: [String(baseMH) == String(item.id) ? null : (baseMH || (pools.mainhand[0] || {}).id || null)],
                }));
        if (pools.twohand.length > view.KEEP_TH)
            for (const item of pools.twohand)
                addJob('twohand', item.id, Object.assign({}, baseline, {
                    twohand: [item.id], mainhand: [null], offhand: [null],
                }));

        const ranks = {};
        if (!jobs.length) return ranks;

        view.setStatus(`Ranking ${jobs.length} bag items...`);
        const res = await view.batch(jobs.map(j => j.combo), view.MARGINAL_ITERS, (d, t) => view.setProgress(d, t));
        for (let i = 0; i < jobs.length; i++) {
            if (!ranks[jobs[i].key]) ranks[jobs[i].key] = {};
            ranks[jobs[i].key][String(jobs[i].id)] = res[i].error ? -1 : res[i].mean;
        }
        return ranks;
    },

    // keep the top n of a pool by marginal rank; items in `always` (set pieces) are kept regardless
    prunePool: function (pool, rank, n, always) {
        if (!rank || pool.length <= n) return pool.slice();
        const sorted = pool.slice().sort((a, b) => (rank[String(b.id)] || 0) - (rank[String(a.id)] || 0));
        return sorted.filter((item, i) => i < n || (always && always.has(String(item.id))));
    },

    // ---------- main flow ----------

    ownedKey: function () {
        return [...this.ownedIds()].sort().join(',');
    },

    beginRun: function () {
        const view = this;
        view.running = true;
        view.cancelled = false;
        view.section.find('.js-run-optimizer, .js-run-finder').addClass('disabled');
        view.section.find('.js-cancel-optimizer').show();
        view.playerConfig = Player.getConfig();
        view.simConfig = Simulation.getConfig();
    },

    endRun: function () {
        const view = this;
        view.running = false;
        view.setProgress(0, 0);
        view.section.find('.js-run-optimizer, .js-run-finder').removeClass('disabled');
        view.section.find('.js-cancel-optimizer').hide();
        if (view._pool) { view._pool.terminate(); view._pool = null; }
    },

    run: async function () {
        const view = this;
        view.beginRun();
        view.results.empty();
        view.finalists = null;
        view.lastRun = null;

        try {
            await view.ensureBestSets();
            view.setStatus(`Done. Evaluated ${view.spaceSize} combinations.`);
        }
        catch (err) {
            if (err === 'cancelled') view.setStatus('Cancelled.');
            else view.setStatus('' + err);
        }
        finally {
            view.endRun();
        }
    },

    // Compute and cache the best-sets result; reused by the upgrade finder.
    ensureBestSets: async function () {
        const view = this;
        const key = view.ownedKey();
        if (view.lastRun && view.lastRun.key === key) return view.lastRun;
        const result = await view.computeBestSets();
        view.finalists = result.candidates.slice(0, 3);
        view.renderResults(result.baseline);
        view.setStatus(`Done. Evaluated ${view.spaceSize} combinations.`);
        view.lastRun = {
            key,
            baseline: result.baseline,
            best: result.candidates[0],
            finalists: result.candidates.slice(0, 16),
        };
        return view.lastRun;
    },

    computeBestSets: async function () {
        const view = this;
        {
            const pools = view.buildPools();
            const owned = view.ownedIds();
            const baseline = view.currentGearMap();
            const setPieces = view.multiSetPieceIds(owned);

            if (!pools.twohand.length && !pools.mainhand.length)
                throw 'No owned weapons. Mark the weapons you own with the bag icon first.';

            const buildGroups = (ranks) => {
                const groups = [];
                const simpleGroups = [];
                for (let slot of view.ARMOR_SLOTS) {
                    const pool = pools[slot];
                    if (!pool.length) continue;
                    const interacting = pool.some(i => setPieces.has(String(i.id)));
                    if (interacting) {
                        const kept = ranks
                            ? view.prunePool(pool, ranks[slot], view.KEEP_INTERACTING, setPieces)
                            : pool;
                        groups.push({ slots: [slot], options: kept.map(i => [i.id]) });
                    }
                    else if (ranks && ranks[slot]) {
                        const ranked = pool.slice().sort((a, b) => (ranks[slot][String(b.id)] || 0) - (ranks[slot][String(a.id)] || 0));
                        const g = {
                            slots: [slot],
                            options: [[ranked[0].id]],
                            ranked: ranked,
                            rankvals: ranked.map(i => ranks[slot][String(i.id)] || 0),
                            added: 1,
                        };
                        groups.push(g);
                        simpleGroups.push(g);
                    }
                    else {
                        groups.push({ slots: [slot], options: pool.map(i => [i.id]) });
                    }
                }
                const fingerPool = ranks ? view.prunePool(pools.finger, ranks.finger, view.KEEP_PAIR, setPieces) : pools.finger;
                const ringOpts = view.pairOptions(fingerPool);
                if (ringOpts.length) groups.push({ slots: ['finger1', 'finger2'], options: ringOpts });

                const trinketPool = ranks ? view.prunePool(pools.trinket, ranks.trinket, view.KEEP_PAIR, setPieces) : pools.trinket;
                const trinketOpts = view.pairOptions(trinketPool);
                if (trinketOpts.length) groups.push({ slots: ['trinket1', 'trinket2'], options: trinketOpts });

                const mhPool = ranks ? view.prunePool(pools.mainhand, ranks.mainhand, view.KEEP_MH, setPieces) : pools.mainhand;
                const ohPool = ranks ? view.prunePool(pools.offhand, ranks.offhand, view.KEEP_OH, setPieces) : pools.offhand;
                const thPool = ranks ? view.prunePool(pools.twohand, ranks.twohand, view.KEEP_TH, setPieces) : pools.twohand;
                groups.push({ slots: ['mainhand', 'offhand', 'twohand'], options: view.weaponOptions(mhPool, ohPool, thPool) });
                return { groups, simpleGroups };
            };

            // try the full space first; prune through marginal ranking when it's too big
            let { groups, simpleGroups } = buildGroups(null);
            if (view.comboCount(groups) > view.MAX_COMBOS) {
                const ranks = await view.rankPools(pools, baseline);
                ({ groups, simpleGroups } = buildGroups(ranks));

                // widen the simple slot whose next runner-up is closest to its best,
                // repeatedly, while the combo count stays under the cap
                while (true) {
                    const product = view.comboCount(groups);
                    let best = null;
                    for (const g of simpleGroups) {
                        if (g.added >= g.ranked.length) continue;
                        const newProduct = product / g.options.length * (g.options.length + 1);
                        if (newProduct > view.MAX_COMBOS) continue;
                        const gap = g.rankvals[0] - g.rankvals[g.added];
                        if (!best || gap < best.gap) best = { g, gap };
                    }
                    if (!best) break;
                    best.g.options.push([best.g.ranked[best.g.added].id]);
                    best.g.added++;
                }
            }

            const total = view.comboCount(groups);
            if (total > view.HARD_MAX_COMBOS)
                throw `Too many combinations (${total}) even after pruning. Remove some items from your bags.`;

            let candidates = view.enumerate(groups);
            view.spaceSize = total;

            // successive-halving race
            let iters = total > 8000 ? 60 : 150;
            const fullIters = Math.max(parseInt(view.simConfig.iterations) || 10000, 1000);
            let round = 1;
            let simmedAt = 0;
            while (candidates.length > view.FINAL_COUNT && round <= 12 && simmedAt < fullIters) {
                view.setStatus(`Round ${round}: simming ${candidates.length} sets at ${iters} iterations each...`);
                const res = await view.batch(candidates, iters, (d, t) => view.setProgress(d, t));
                for (let i = 0; i < candidates.length; i++) Object.assign(candidates[i], res[i]);
                candidates = candidates.filter(c => !c.error);
                candidates.sort((a, b) => b.mean - a.mean);
                simmedAt = iters;
                if (iters >= fullIters) break;
                const keepCount = Math.max(view.FINAL_COUNT, Math.ceil(candidates.length / 4));
                const cutoff = candidates[Math.min(keepCount, candidates.length) - 1];
                candidates = candidates.filter((c, i) =>
                    i < keepCount ||
                    (c.mean + 1.96 * Math.sqrt(c.varmean)) >= (cutoff.mean - 1.96 * Math.sqrt(cutoff.varmean)));
                iters = Math.min(iters * 4, fullIters);
                round++;
            }

            if (simmedAt < fullIters) {
                view.setStatus(`Final: simming ${candidates.length} sets at ${fullIters} iterations each...`);
                const res = await view.batch(candidates, fullIters, (d, t) => view.setProgress(d, t));
                for (let i = 0; i < candidates.length; i++) Object.assign(candidates[i], res[i]);
                candidates = candidates.filter(c => !c.error);
                candidates.sort((a, b) => b.mean - a.mean);
            }

            return { candidates, baseline };
        }
    },

    // ---------- results ----------

    comboIds: function (gearmap) {
        const ids = [];
        for (let slot in gearmap)
            for (let id of gearmap[slot])
                if (id !== null && id !== undefined) ids.push(id);
        return ids;
    },

    comboSets: function (gearmap) {
        const ids = this.comboIds(gearmap);
        const active = [];
        for (let set of sets) {
            let counter = 0;
            for (let id of set.items) if (ids.some(i => i == id)) counter++;
            if (counter && set.bonus.some(b => counter >= b.count))
                active.push(`${set.name} (${counter})`);
        }
        return active;
    },

    slotLabel: function (slot) {
        return slot.replace('finger', 'ring ').replace('trinket', 'trinket ')
                   .replace('twohand', 'two hand').replace('mainhand', 'main hand').replace('offhand', 'off hand');
    },

    renderResults: function (baseline) {
        const view = this;
        const slotIndex = view.itemSlotIndex();
        const currentIds = new Set(view.comboIds(baseline).map(String));
        const ranklabel = ['1st', '2nd', '3rd'];
        let html = '';

        view.finalists.forEach((combo, index) => {
            const err = (1.96 * Math.sqrt(combo.varmean)).toFixed(1);
            let items = '';
            for (let slot of view.DISPLAY_SLOTS) {
                if (!combo.gearmap[slot]) continue;
                for (let id of combo.gearmap[slot]) {
                    if (id === null || id === undefined) continue;
                    const entry = slotIndex[id];
                    const item = entry ? entry.item : null;
                    const changed = !currentIds.has(String(id));
                    items += `<li data-quality="${item ? item.q : 2}" class="${changed ? 'changed' : ''}">
                        <span class="opt-slot">${view.slotLabel(slot)}</span>
                        <p>${item ? item.name : id}</p></li>`;
                }
            }
            const setbonuses = view.comboSets(combo.gearmap);
            html += `<div class="opt-set">
                <div class="opt-rank">${ranklabel[index] || (index + 1) + 'th'}</div>
                <div class="opt-dps">${combo.mean.toFixed(1)} <span class="opt-err">&plusmn; ${err}</span></div>
                <ul>${items}</ul>
                ${setbonuses.length ? `<div class="opt-setbonus">${setbonuses.join('<br>')}</div>` : ''}
                <a href="#" class="btn js-equip-set" data-index="${index}">EQUIP</a>
            </div>`;
        });

        view.results.html(html);
    },

    equip: function (gearmap) {
        applyGearMap(gearmap);
        SIM.UI.updateSession();
        SIM.UI.updateSidebar();
        SIM.SETTINGS.buildSpells();
        SIM.UI.filterGear();
    },

    // ---------- upgrade finder ----------

    FINDER_SLOTS: null, // set lazily: armor slots + finger1/trinket1 + weapons

    setFinderStatus: function (msg) {
        this.section.find('.opt-finder-status').text(msg);
    },

    // same source bucket mapping the gear tables use for the sidebar filter
    sourceBucket: function (item) {
        let source = (item.source || '').toLowerCase();
        if (item.source == 'Lethon' || item.source == 'Emeriss' || item.source == 'Kazzak' || item.source == 'Azuregos' ||
            item.source == 'Ysondre' || item.source == 'Taerar' || item.source == 'Green Dragons')
            source = 'worldboss';
        if (item.subsource == 'shadow' || item.subsource == 'arcane' || item.subsource == 'nature' ||
            item.subsource == 'fire' || item.subsource == 'frost')
            source = 'resistances-list';
        if (source == 'world drop' || source == 'other' || source == 'ubrs' || source == 'pyroguard emberseer' ||
            source == 'lord incendius' || source == 'goraluk anvilcrack' || source == 'maleki the pallid')
            source = source == 'world drop' ? 'other' : (source == 'other' ? 'other' : 'dungeon');
        return source;
    },

    upgradeCandidates: function (bucket) {
        const view = this;
        const owned = view.ownedIds();
        const filter = $('article.filter');
        const storage = JSON.parse(localStorage[mode + (globalThis.profileid || 0)]);
        const level = parseInt(storage.level);
        const out = [];
        const searchSlots = [...view.ARMOR_SLOTS, 'finger1', 'trinket1', 'mainhand', 'offhand', 'twohand'];
        for (const slot of searchSlots) {
            for (const item of gear[slot]) {
                if (owned.has(String(item.id))) continue;
                if (item.hidden) continue;
                if (item.r > level) continue;
                if (view.sourceBucket(item) != bucket) continue;
                const phase = item.phase;
                if (phase && !filter.find('.phases [data-id="' + phase + '"]').hasClass('active')) continue;
                out.push({ item, slot });
            }
        }
        return out;
    },

    placePiece: function (gearmap, pid, slots, protectedIds) {
        // skip if already placed anywhere it can go
        for (const s of slots)
            if (gearmap[s] && String(gearmap[s][0]) == String(pid)) return;
        for (const s of slots) {
            const cur = gearmap[s] && gearmap[s][0];
            if (protectedIds.has(String(cur))) continue;
            gearmap[s] = [pid];
            if (s == 'mainhand' || s == 'offhand') delete gearmap.twohand;
            if (s == 'twohand') { delete gearmap.mainhand; delete gearmap.offhand; }
            return;
        }
    },

    insertionVariants: function (cand, baseMaps, pools) {
        const view = this;
        const cid = cand.item.id;
        const out = new Map();
        const keyOf = (m) => view.DISPLAY_SLOTS.map(s => (m[s] || []).map(String).sort().join('/')).join('|');
        const push = (m) => { out.set(keyOf(m), m); };
        const clone = (bm) => { const m = {}; for (const s in bm) if (bm[s] && bm[s][0] != null) m[s] = bm[s].slice(); return m; };

        for (const bm of baseMaps) {
            if (view.ARMOR_SLOTS.includes(cand.slot)) {
                const m = clone(bm);
                m[cand.slot] = [cid];
                push(m);
            }
            else if (cand.slot == 'finger1' || cand.slot == 'trinket1') {
                const a = cand.slot.replace('1', '') + '1', b = cand.slot.replace('1', '') + '2';
                for (const s of [a, b]) {
                    const other = s == a ? b : a;
                    const m = clone(bm);
                    if (m[other] && String(m[other][0]) == String(cid)) continue;
                    m[s] = [cid];
                    push(m);
                }
            }
            else if (cand.slot == 'mainhand') {
                const m = clone(bm);
                m.mainhand = [cid];
                delete m.twohand;
                if (m.offhand && String(m.offhand[0]) == String(cid)) delete m.offhand;
                if (!m.offhand && pools.offhand.length) m.offhand = [pools.offhand[0].id];
                push(m);
            }
            else if (cand.slot == 'offhand') {
                const m = clone(bm);
                m.offhand = [cid];
                delete m.twohand;
                if (!m.mainhand || String(m.mainhand[0]) == String(cid)) {
                    const mh = pools.mainhand.find(i => String(i.id) != String(cid));
                    if (!mh) continue;
                    m.mainhand = [mh.id];
                }
                push(m);
            }
            else if (cand.slot == 'twohand') {
                const m = clone(bm);
                m.twohand = [cid];
                delete m.mainhand;
                delete m.offhand;
                push(m);
            }
        }

        // if the candidate belongs to a set the player owns pieces of, also try
        // completing that set on top of the inserted variants
        const owned = view.ownedIds();
        const slotIndex = view.itemSlotIndex();
        for (const set of sets) {
            if (!set.items.some(i => i == cid)) continue;
            const ownedPieces = set.items.filter(i => owned.has(String(i)) && i != cid);
            if (!ownedPieces.length) continue;
            const protectedIds = new Set([String(cid)]);
            for (const m0 of [...out.values()].slice(0, 8)) {
                const m = clone(m0);
                for (const pid of ownedPieces) {
                    const entry = slotIndex[pid];
                    if (!entry) continue;
                    view.placePiece(m, pid, entry.slots, protectedIds);
                    protectedIds.add(String(pid));
                }
                push(m);
            }
        }

        return [...out.values()];
    },

    runFinder: async function (bucket) {
        const view = this;
        view.beginRun();
        const table = view.section.find('.opt-finder-results');
        table.empty();

        try {
            view.setFinderStatus('Computing baseline best set from bags...');
            const base = await view.ensureBestSets();
            const pools = view.buildPools();

            const cands = view.upgradeCandidates(bucket);
            if (!cands.length) throw 'No candidate items for this source (check the phase filters in Settings).';

            const baseMaps = base.finalists.slice(0, cands.length > 40 ? 8 : 16).map(f => f.gearmap);
            let combos = [];
            for (const cand of cands) {
                const variants = view.insertionVariants(cand, baseMaps, pools);
                for (const gearmap of variants) combos.push({ gearmap, cand });
            }
            if (!combos.length) throw 'No viable combinations for these candidates.';

            const keepBestPerCand = (list, n) => {
                const byCand = new Map();
                for (const c of list) {
                    if (!byCand.has(c.cand)) byCand.set(c.cand, []);
                    byCand.get(c.cand).push(c);
                }
                const out = [];
                for (const [, arr] of byCand) {
                    arr.sort((a, b) => b.mean - a.mean);
                    out.push(...arr.slice(0, n));
                }
                return out;
            };

            const simRound = async (list, iters, label) => {
                view.setFinderStatus(`${label}: simming ${list.length} variants at ${iters} iterations...`);
                const res = await view.batch(list, iters, (d, t) => view.setProgress(d, t));
                for (let i = 0; i < list.length; i++) Object.assign(list[i], res[i]);
                return list.filter(c => !c.error);
            };

            combos = await simRound(combos, 150, 'Round 1');
            combos = keepBestPerCand(combos, 2);
            combos = await simRound(combos, 1500, 'Round 2');
            combos = keepBestPerCand(combos, 1);

            const fullIters = Math.min(Math.max(parseInt(view.simConfig.iterations) || 10000, 1000), 10000);
            const baselineCombo = { gearmap: base.best.gearmap, cand: null };
            const finals = await simRound([baselineCombo, ...combos], fullIters, 'Final');

            const baseResult = finals.find(c => c.cand === null);
            const upgrades = finals.filter(c => c.cand !== null);
            upgrades.sort((a, b) => b.mean - a.mean);
            view.renderFinder(bucket, baseResult, upgrades);
            view.setFinderStatus(`Done. Baseline (best owned set): ${baseResult.mean.toFixed(1)} DPS at ${fullIters} iterations.`);
        }
        catch (err) {
            if (err === 'cancelled') view.setFinderStatus('Cancelled.');
            else view.setFinderStatus('' + err);
        }
        finally {
            view.endRun();
        }
    },

    renderFinder: function (bucket, baseResult, upgrades) {
        const view = this;
        const slotIndex = view.itemSlotIndex();
        const baseIds = new Set(view.comboIds(baseResult.gearmap).map(String));

        let rows = '';
        for (const u of upgrades) {
            const delta = u.mean - baseResult.mean;
            const err = 1.96 * Math.sqrt((u.varmean || 0) + (baseResult.varmean || 0));
            const swaps = [];
            for (const slot of view.DISPLAY_SLOTS) {
                const ids = (u.gearmap[slot] || []).filter(id => id != null);
                for (const id of ids) {
                    if (String(id) == String(u.cand.item.id)) continue;
                    if (baseIds.has(String(id))) continue;
                    const entry = slotIndex[id];
                    swaps.push(`${view.slotLabel(slot)} &rarr; ${entry ? entry.item.name : id}`);
                }
            }
            const tooltip = String(u.cand.item.id).split('|')[0];
            rows += `<tr>
                <td data-quality="${u.cand.item.q}"><a href="${WEB_DB_URL}item=${tooltip}" target="_blank">${u.cand.item.name}</a></td>
                <td>${view.slotLabel(u.cand.slot)}</td>
                <td class="${delta >= 0 ? 'p' : 'n'}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)} &plusmn; ${err.toFixed(1)}</td>
                <td class="opt-swaps">${swaps.length ? swaps.join('<br>') : ''}</td>
            </tr>`;
        }

        view.section.find('.opt-finder-results').html(`
            <table class="opt-finder-table">
                <thead><tr><th>Item</th><th>Slot</th><th>&Delta;DPS</th><th>Also swap (re-optimized)</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`);
    },
};
