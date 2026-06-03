const map = L.map('map', { doubleClickZoom: false }).setView([35.6812, 139.7671], 5);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }).addTo(map);

const PREF_NAMES = {
    1:"北海道",2:"青森県",3:"岩手県",4:"宮城県",5:"秋田県",6:"山形県",7:"福島県",8:"茨城県",9:"栃木県",10:"群馬県",
    11:"埼玉県",12:"千葉県",13:"東京都",14:"神奈川県",15:"新潟県",16:"富山県",17:"石川県",18:"福井県",19:"山梨県",20:"長野県",
    21:"岐阜県",22:"静岡県",23:"愛知県",24:"三重県",25:"滋賀県",26:"京都府",27:"大阪府",28:"兵庫県",29:"奈良県",30:"和歌山県",
    31:"鳥取県",32:"島根県",33:"岡山県",34:"広島県",35:"山口県",36:"徳島県",37:"香川県",38:"愛媛県",39:"高知県",40:"福岡県",
    41:"佐賀県",42:"長崎県",43:"熊本県",44:"大分県",45:"宮崎県",46:"鹿児島県",47:"沖縄県"
};

map.createPane('voronoiPane');  map.getPane('voronoiPane').style.zIndex = 390;
map.createPane('linePane');     map.getPane('linePane').style.zIndex = 400;
map.createPane('stationPane');  map.getPane('stationPane').style.zIndex = 410;
map.createPane('viewPane');     map.getPane('viewPane').style.zIndex = 430; // 👁️ 眺めるモード専用の最前面ペイン

const voronoiRenderer = L.canvas({ pane: 'voronoiPane' });
const lineRenderer = L.canvas({ pane: 'linePane', tolerance: 10 });
const stationRenderer = L.canvas({ pane: 'stationPane' });
const viewRenderer = L.canvas({ pane: 'viewPane', tolerance: 15 }); // 👁️ 共通Canvas (吸い付きやすいようにtolerance初期値拡大)

const lineListUrl = 'db_files/out/main/line.json';
const stationListUrl = 'db_files/out/main/station.json';

let conqueredLines = JSON.parse(localStorage.getItem('conqueredLines')) || [];
let conqueredStations = JSON.parse(localStorage.getItem('conqueredStations')) || [];

let isVoronoiVisible = JSON.parse(localStorage.getItem('isVoronoiVisible')) || false;
document.getElementById('chk-voronoi').checked = isVoronoiVisible;

let allLines = [];
let allStations = []; 
const lineLayers = {}; 
let isDisplayInverted = false;
let currentMode = 'normal'; 
let registerMode = 'view'; // 👁️ 初期値を眺めるモードに変更
const expandedLineCodes = new Set();

const stationLayerGroup = L.layerGroup().addTo(map);
const voronoiLayerGroup = L.layerGroup();

let isLinesLoaded = false;
let isStationsLoaded = false;
let isVoronoiLoaded = false; 
let totalPolylinesToLoad = 0;
let loadedPolylinesCount = 0;
let isDrawingStarted = false; 
let isAppInitialized = false;

// --- ↩️ 操作履歴（Undo）管理機能 ---
const MAX_HISTORY = 20; 
let historyStack = [];

function saveHistory() {
    historyStack.push({
        lines: [...conqueredLines],
        stations: [...conqueredStations]
    });
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift(); 
    }
}

function performUndo() {
    if (registerMode === 'view') return; // 眺めるモード中はUndo操作もブロック
    if (historyStack.length === 0) {
        console.log('戻せる履歴がありません。');
        return;
    }
    const previousState = historyStack.pop();
    conqueredLines = previousState.lines;
    conqueredStations = previousState.stations;
    localStorage.setItem('conqueredLines', JSON.stringify(conqueredLines));
    localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations));
    refreshAllLines();
}

window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); 
        performUndo();
    }
});

function getPrefCode(s) {
    if (s.pref !== undefined && s.pref !== null && s.pref !== "") return Number(s.pref);
    if (s.prefecture !== undefined && s.prefecture !== null && s.prefecture !== "") return Number(s.prefecture);
    if (s.pref_cd !== undefined && s.pref_cd !== null && s.pref_cd !== "") return Number(s.pref_cd);
    return null;
}

startApp();

function updateRegisterMode(mode) {
    registerMode = mode;
    const linePane = map.getPane('linePane');
    const stationPane = map.getPane('stationPane');
    const viewPane = map.getPane('viewPane');
    
    let targetLineRenderer = lineRenderer;
    let targetStationRenderer = stationRenderer;
    
    if (mode === 'view') {
        // 👁️ 眺めるモード：最前面ペインをONにし、駅と路線の描画先を同じCanvasに統合する
        viewPane.style.zIndex = 430;
        linePane.style.zIndex = 400;
        stationPane.style.zIndex = 400;
        targetLineRenderer = viewRenderer;
        targetStationRenderer = viewRenderer;
    } else if (mode === 'line') {
        linePane.style.zIndex = 420;
        stationPane.style.zIndex = 410;
        viewPane.style.zIndex = 400;
    } else {
        stationPane.style.zIndex = 420;
        linePane.style.zIndex = 410;
        viewPane.style.zIndex = 400;
    }

    // 🗺️ 路線レイヤーの Canvas レンダラーを動的に差し替え
    allLines.forEach(line => {
        const geojsonLayer = lineLayers[line.code];
        if (geojsonLayer) {
            let needRefresh = false;
            geojsonLayer.eachLayer(layer => {
                if (layer.options.renderer !== targetLineRenderer) {
                    layer.options.renderer = targetLineRenderer;
                    needRefresh = true;
                }
            });
            // レンダラーが変わった場合のみ、マップから脱着して再描画を促す
            if (needRefresh && map.hasLayer(geojsonLayer)) {
                map.removeLayer(geojsonLayer);
                map.addLayer(geojsonLayer);
            }
        }
    });

    // 📍 駅レイヤーの Canvas レンダラーを動的に差し替え
    stationLayerGroup.eachLayer(marker => {
        if (marker.options.renderer !== targetStationRenderer) {
            marker.removeFrom(stationLayerGroup);
            marker.options.renderer = targetStationRenderer;
            marker.addTo(stationLayerGroup);
        }
    });
}

function checkAppReady() {
    if (isLinesLoaded && isStationsLoaded && isVoronoiLoaded && loadedPolylinesCount >= totalPolylinesToLoad) {
        if (!isAppInitialized) {
            isAppInitialized = true;
            updateRegisterMode('view'); // 👁️ 初期化時も眺めるモードで起動
            refreshAllLines();

            updateStatusText('描画キャッシュ構築中...');
            setTimeout(() => {
                map.panBy([1, 1], { animate: false });
                map.panBy([-1, -1], { animate: false });

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        setTimeout(() => {
                            const overlay = document.getElementById('loading-overlay');
                            if (overlay && !overlay.classList.contains('loaded')) {
                                overlay.classList.add('loaded');
                            }
                        }, 200);
                    });
                });
            }, 100);
        }
    }
}

function updateStatusText(text) {
    const statusEl = document.getElementById('loading-status');
    if (statusEl) { statusEl.textContent = text; }
}

function updateCounter() {
    document.getElementById('conquered-count').textContent = conqueredLines.length;
    document.getElementById('total-count').textContent = allLines.length;

    if (allStations.length > 0) {
        const checkSet = new Set(conqueredStations);
        let checkCount = 0;
        stationLayerGroup.eachLayer(marker => {
            const isChecked = checkSet.has(marker.stationCode);
            marker.isCheckIn = isChecked;
            if (isChecked) checkCount++;
        });
        document.getElementById('conquered-stations-count').textContent = checkCount;
        document.getElementById('total-stations-count').textContent = allStations.length;
    }
}

function updatePrefPanel() {
    const container = document.getElementById('pref-list-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (allStations.length === 0) return;
    const checkStationSet = new Set(conqueredStations);
    
    for (let code = 1; code <= 47; code++) {
        if (!PREF_NAMES[code]) continue;

        const prefStations = allStations.filter(s => getPrefCode(s) === code);
        if (prefStations.length === 0) continue;
        
        const totalCount = prefStations.length;
        const conqueredCount = prefStations.filter(s => checkStationSet.has(s.code)).length;
        const percent = totalCount > 0 ? (conqueredCount / totalCount) * 100 : 0;
        
        const itemContainer = document.createElement('div');
        itemContainer.className = 'pref-item-container';
        
        const leftPart = document.createElement('div');
        leftPart.className = 'pref-item-left';
        
        const titleRow = document.createElement('div');
        titleRow.className = 'pref-title-row';
        titleRow.textContent = PREF_NAMES[code];
        leftPart.appendChild(titleRow);
        
        const progressRow = document.createElement('div');
        progressRow.className = 'pref-progress-row';
        
        const barBg = document.createElement('div');
        barBg.className = 'progress-bar-bg';
        
        const barFill = document.createElement('div');
        barFill.className = 'progress-bar-fill';
        barFill.style.background = '#00ffff'; 
        barFill.style.width = `${percent}%`;
        barBg.appendChild(barFill);
        
        const txt = document.createElement('div');
        txt.className = 'progress-text';
        txt.innerHTML = `<span style="color: #00ffff; font-weight: bold;">${conqueredCount}</span>/${totalCount}`;
        
        progressRow.appendChild(barBg);
        progressRow.appendChild(txt);
        leftPart.appendChild(progressRow);
        
        const jumpBtn = document.createElement('button');
        jumpBtn.className = 'btn-jump';
        jumpBtn.textContent = '🔍';
        jumpBtn.title = `${PREF_NAMES[code]}の駅全体にフォーカス`;
        jumpBtn.addEventListener('click', () => {
            const points = prefStations.map(s => L.latLng(s.lat, s.lng));
            const bounds = L.latLngBounds(points);
            if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 9, animate: true });
        });
        
        itemContainer.appendChild(leftPart);
        itemContainer.appendChild(jumpBtn);
        container.appendChild(itemContainer);
    }
}

function updateSidebarList() {
    const listContainer = document.getElementById('sidebar-line-list');
    if (!listContainer) return;
    listContainer.innerHTML = ''; 
    const query = document.getElementById('sidebar-search').value.toLowerCase();

    let filteredTotal = 0;
    let filteredConquered = 0;
    const checkStationSet = new Set(conqueredStations);

    allLines.forEach(line => {
        if (query && !line.name.toLowerCase().includes(query)) return;

        filteredTotal++;
        const isConquered = conqueredLines.includes(line.code);
        if (isConquered) filteredConquered++;

        const lineStations = allStations.filter(s => s.lines && s.lines.includes(line.code));
        const totalStationsInLine = lineStations.length;
        const conqueredStationsInLine = lineStations.filter(s => checkStationSet.has(s.code)).length;
        const percent = totalStationsInLine > 0 ? (conqueredStationsInLine / totalStationsInLine) * 100 : 0;

        const container = document.createElement('div');
        container.className = 'line-container';

        const item = document.createElement('div');
        item.className = 'line-item';
        
        const leftPart = document.createElement('div');
        leftPart.className = 'line-item-left';
        
        const titleRow = document.createElement('label');
        titleRow.className = 'line-title-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isConquered;
        checkbox.disabled = (registerMode === 'view'); // 眺めるモードの時はロック
        checkbox.addEventListener('change', (e) => { e.stopPropagation(); toggleLine(line.code); });
        const nameText = document.createTextNode(line.name);
        titleRow.appendChild(checkbox);
        titleRow.appendChild(nameText);
        leftPart.appendChild(titleRow);

        const progressRow = document.createElement('div');
        progressRow.className = 'line-progress-row';
        const barBg = document.createElement('div');
        barBg.className = 'progress-bar-bg';
        const barFill = document.createElement('div');
        barFill.className = 'progress-bar-fill';
        barFill.style.width = `${percent}%`;
        barBg.appendChild(barFill);
        const txt = document.createElement('div');
        txt.className = 'progress-text';
        txt.innerHTML = `<span class="conquered-num">${conqueredStationsInLine}</span>/${totalStationsInLine}`;
        progressRow.appendChild(barBg);
        progressRow.appendChild(txt);
        leftPart.appendChild(progressRow);
        
        const rightPart = document.createElement('div');
        rightPart.className = 'line-item-right';
        const jumpBtn = document.createElement('button');
        jumpBtn.className = 'btn-jump';
        jumpBtn.textContent = '🔍';
        jumpBtn.title = 'この路線にフォーカス';
        jumpBtn.addEventListener('click', () => {
            const geojsonLayer = lineLayers[line.code];
            if (geojsonLayer && geojsonLayer.getBounds().isValid()) {
                map.fitBounds(geojsonLayer.getBounds(), { maxZoom: 12, animate: true });
            }
        });

        const expandBtn = document.createElement('button');
        expandBtn.className = 'btn-expand';
        const isExpanded = expandedLineCodes.has(line.code);
        expandBtn.textContent = isExpanded ? '▲' : '▼';
        rightPart.appendChild(jumpBtn);
        rightPart.appendChild(expandBtn);

        item.appendChild(leftPart);
        item.appendChild(rightPart);
        container.appendChild(item);

        const subList = document.createElement('div');
        subList.className = 'station-sub-list';
        if (isExpanded) subList.classList.add('expanded');

        if (isExpanded) {
            lineStations.forEach(st => {
                const stItem = document.createElement('div');
                stItem.className = 'station-sub-item';

                const stLeft = document.createElement('label');
                stLeft.className = 'station-sub-left';
                const stCheck = document.createElement('input');
                stCheck.type = 'checkbox';
                stCheck.checked = checkStationSet.has(st.code);
                stCheck.disabled = (registerMode === 'view'); // 眺めるモードの時はロック
                stCheck.addEventListener('change', () => { toggleStationCheckIn(st.code); });
                const stNameSpan = document.createElement('span');
                stNameSpan.textContent = st.name;
                stLeft.appendChild(stCheck);
                stLeft.appendChild(stNameSpan);

                if (st.closed) {
                    const closedTag = document.createElement('span');
                    closedTag.className = 'closed-tag';
                    closedTag.textContent = '廃駅';
                    stLeft.appendChild(closedTag);
                }

                const stJump = document.createElement('button');
                stJump.className = 'btn-station-jump';
                stJump.textContent = '📍';
                stJump.title = 'この駅にジャンプ';
                stJump.addEventListener('click', () => {
                    map.setView([st.lat, st.lng], 14, { animate: true });
                });

                stItem.appendChild(stLeft);
                stItem.appendChild(stJump);
                subList.appendChild(stItem);
            });
        }
        container.appendChild(subList);

        expandBtn.addEventListener('click', () => {
            if (expandedLineCodes.has(line.code)) { expandedLineCodes.delete(line.code); } 
            else { expandedLineCodes.add(line.code); }
            updateSidebarList(); 
        });
        listContainer.appendChild(container);
    });

    document.getElementById('filtered-conquered').textContent = filteredConquered;
    document.getElementById('filtered-total').textContent = filteredTotal;
    
    const statsTextNode = document.getElementById('search-result-stats').childNodes[0];
    if (query) { statsTextNode.nodeValue = '検索結果: '; } 
    else { statsTextNode.nodeValue = '全路線: '; }
}

function getSafeLineColor(conquered, line) {
    let baseColor = line.color ? line.color : '#3388ff';
    if (currentMode === 'station-only') { return 'transparent'; } 
    else if (currentMode === 'station-heavy') { return '#444966'; }
    const hex = baseColor.replace('#', '');
    if (hex.length === 6) {
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        if (r < 45 && g < 45 && b < 45) {
            const shouldHighlight = isDisplayInverted ? !conquered : conquered;
            return shouldHighlight ? '#ffffff' : '#aaaaaa'; 
        }
    }
    return baseColor;
}

function getLineStyle(conquered, line) {
    const shouldHighlight = isDisplayInverted ? !conquered : conquered;
    const finalColor = getSafeLineColor(conquered, line);
    let weight = shouldHighlight ? 7 : 3;
    let opacity = shouldHighlight ? 1.0 : 0.4;
    if (currentMode === 'station-only') { opacity = 0; weight = 0; } 
    else if (currentMode === 'station-heavy') { opacity = 0.65; weight = 2; }
    return { color: finalColor, weight: weight, opacity: opacity };
}

function toggleLine(lineCode) {
    if (registerMode === 'view') return; // 眺めるモード時は拒絶
    conqueredLines = JSON.parse(localStorage.getItem('conqueredLines')) || [];
    conqueredStations = JSON.parse(localStorage.getItem('conqueredStations')) || [];
    const line = allLines.find(l => l.code === lineCode);
    if (!line) return;

    saveHistory();

    const targetStationCodes = allStations.filter(s => s.lines && s.lines.includes(lineCode)).map(s => s.code);
    if (!conqueredLines.includes(lineCode)) { 
        conqueredLines.push(lineCode);
        targetStationCodes.forEach(code => { if (!conqueredStations.includes(code)) conqueredStations.push(code); });
    } else { 
        conqueredLines = conqueredLines.filter(code => code !== lineCode);
        conqueredStations = conqueredStations.filter(code => !targetStationCodes.includes(code));
    }
    localStorage.setItem('conqueredLines', JSON.stringify(conqueredLines));
    localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations));
    refreshAllLines();
}

function toggleStationCheckIn(stationCode) {
    if (registerMode === 'view') return; // 眺めるモード時は拒絶
    conqueredStations = JSON.parse(localStorage.getItem('conqueredStations')) || [];
    conqueredLines = JSON.parse(localStorage.getItem('conqueredLines')) || [];
    const station = allStations.find(s => s.code === stationCode);
    if (!station) return;

    saveHistory();

    if (!conqueredStations.includes(stationCode)) { conqueredStations.push(stationCode); } 
    else { conqueredStations = conqueredStations.filter(code => code !== stationCode); }
    localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations));

    if (station.lines && station.lines.length > 0) {
        const stationCheckSet = new Set(conqueredStations);
        station.lines.forEach(lineCode => {
            const lineStationCodes = allStations.filter(s => s.lines && s.lines.includes(lineCode)).map(s => s.code);
            const isAllConquered = lineStationCodes.every(code => stationCheckSet.has(code));
            if (isAllConquered) {
                if (!conqueredLines.includes(lineCode)) { conqueredLines.push(lineCode); }
            } else {
                conqueredLines = conqueredLines.filter(code => code !== lineCode);
            }
        });
        localStorage.setItem('conqueredLines', JSON.stringify(conqueredLines));
    }
    refreshAllLines();
}

function togglePrefectures(prefCode) {
    if (registerMode === 'view') return; // 眺めるモード時は拒絶
    conqueredStations = JSON.parse(localStorage.getItem('conqueredStations')) || [];
    conqueredLines = JSON.parse(localStorage.getItem('conqueredLines')) || [];
    
    const targetPrefNumber = Number(prefCode);
    
    const targetStations = allStations.filter(s => getPrefCode(s) === targetPrefNumber);
    if (targetStations.length === 0) return;

    saveHistory();

    const targetStationCodes = targetStations.map(s => s.code);
    const currentCheckedCount = targetStations.filter(s => conqueredStations.includes(s.code)).length;

    const isRemoving = currentCheckedCount > (targetStations.length / 2);
    
    if (isRemoving) {
        conqueredStations = conqueredStations.filter(code => !targetStationCodes.includes(code));
        targetStations.forEach(st => {
            if (st.lines) {
                st.lines.forEach(lCode => { conqueredLines = conqueredLines.filter(code => code !== lCode); });
            }
        });
        alert(`${PREF_NAMES[targetPrefNumber]} 内の全駅・関連路線のチェックインを解除しました。`);
    } else {
        targetStationCodes.forEach(code => { if (!conqueredStations.includes(code)) conqueredStations.push(code); });
        const affectedLineCodes = new Set();
        targetStations.forEach(st => { if (st.lines) st.lines.forEach(lCode => affectedLineCodes.add(lCode)); });

        const stationCheckSet = new Set(conqueredStations);
        affectedLineCodes.forEach(lCode => {
            const lineStationCodes = allStations.filter(s => s.lines && s.lines.includes(lCode)).map(s => s.code);
            if (lineStationCodes.every(code => stationCheckSet.has(code))) {
                if (!conqueredLines.includes(lCode)) conqueredLines.push(lCode);
            }
        });
        alert(`${PREF_NAMES[targetPrefNumber]} 内のすべての駅 (${targetStations.length}駅) を一括チェックインしました！`);
    }

    localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations));
    localStorage.setItem('conqueredLines', JSON.stringify(conqueredLines));
    refreshAllLines();
}

function syncLegacyData() {
    if (conqueredLines.length > 0 && allStations.length > 0) {
        let updated = false;
        const lineSet = new Set(conqueredLines);
        const stationSet = new Set(conqueredStations);
        allStations.forEach(station => {
            const hasConqueredLine = station.lines && station.lines.some(lCode => lineSet.has(lCode));
            if (hasConqueredLine && !stationSet.has(station.code)) {
                conqueredStations.push(station.code);
                stationSet.add(station.code);
                updated = true;
            }
        });
        if (updated) { localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations)); }
    }
}

function getVoronoiStyle(isCheckIn) {
    if (!isCheckIn) {
        return { color: '#333659', weight: 0.5, fillColor: 'transparent', fillOpacity: 0 };
    }
    return { color: '#00ffff', weight: 1, fillColor: '#00ffff', fillOpacity: 0.15 };
}

function updateVoronoiStyles() {
    if (!isVoronoiVisible) return;
    const checkSet = new Set(conqueredStations);
    voronoiLayerGroup.eachLayer(layer => {
        const isCheckIn = checkSet.has(layer.stationCode);
        layer.setStyle(getVoronoiStyle(isCheckIn));
    });
}

function refreshAllLines() {
    // 💡 路線操作・閲覧モード（眺める、路線強調、路線一括登録）の時は当たり判定の許容ピクセル（tolerance）を大きく拡張
    if (currentMode === 'line-only' || registerMode === 'line' || registerMode === 'view') {
        lineRenderer.options.tolerance = 15; 
        if (typeof viewRenderer !== 'undefined') viewRenderer.options.tolerance = 15;
    } else if (currentMode === 'station-only') {
        lineRenderer.options.tolerance = 0;
        if (typeof viewRenderer !== 'undefined') viewRenderer.options.tolerance = 0;
    } else {
        lineRenderer.options.tolerance = 10;
        if (typeof viewRenderer !== 'undefined') viewRenderer.options.tolerance = 10;
    }

    const backgroundLayers = [];
    const foregroundLayers = [];

    allLines.forEach(line => {
        const geojsonLayer = lineLayers[line.code];
        if (!geojsonLayer) return;
        const isConquered = conqueredLines.includes(line.code);
        geojsonLayer.eachLayer(l => l.setStyle(getLineStyle(isConquered, line)));
        const shouldBringToFront = isDisplayInverted ? isConquered : !isConquered;
        if (shouldBringToFront) { foregroundLayers.push(geojsonLayer); } 
        else { backgroundLayers.push(geojsonLayer); }
    });

    backgroundLayers.forEach(layer => layer.bringToFront());
    foregroundLayers.forEach(layer => layer.bringToFront());

    // 👁️ 眺めるモードの時は同一 Canvas 内に混在するため、路線の重なりを整理した直後に「駅」を最前面に持ってくる
    if (registerMode === 'view') {
        stationLayerGroup.eachLayer(marker => {
            if (typeof marker.bringToFront === 'function') {
                marker.bringToFront();
            }
        });
    }

    updateCounter();
    updatePrefPanel(); 

    const currentZoom = map.getZoom();
    const isStationInteractive = (currentMode !== 'line-only');

    stationLayerGroup.eachLayer(marker => {
        marker.setStyle(getStationStyle(marker.isClosedStation, currentZoom, marker.isCheckIn));
        if (marker._path) {
            if (isStationInteractive) { marker._path.classList.add('leaflet-interactive'); } 
            else { marker._path.classList.remove('leaflet-interactive'); }
        }
        marker.options.interactive = isStationInteractive;
    });

    updateVoronoiStyles();
    updateSidebarList();
}

function startApp() {
    updateStatusText('路線リスト取得中...');
    fetch(lineListUrl).then(response => response.json()).then(lines => {
        allLines = lines; 
        totalPolylinesToLoad = lines.length; 
        isLinesLoaded = true;
        updateSidebarList();

        lines.forEach(line => {
            fetch(`db_files/out/main/polyline/${line.code}.json`).then(r => r.json()).then(geojsonData => {
                if (!isDrawingStarted && isStationsLoaded) {
                    isDrawingStarted = true;
                    updateStatusText('路線マップ描画中...');
                }
                const isConquered = conqueredLines.includes(line.code);
                const geojsonLayer = L.geoJSON(geojsonData, {
                    renderer: lineRenderer, 
                    style: getLineStyle(isConquered, line),
                    onEachFeature: function (feature, layer) {
                        layer.on('mouseover', function (e) {
                            if (currentMode === 'station-only') return; 
                            const parentLayer = lineLayers[line.code];
                            if (parentLayer) {
                                parentLayer.eachLayer(l => l.setStyle({ weight: getLineStyle(conqueredLines.includes(line.code), line).weight + 3, opacity: 1.0 }));
                            }
                            layer.bindTooltip(line.name, { sticky: true, direction: 'top', className: 'line-tooltip' }).openTooltip();
                        });
                        layer.on('mouseout', function (e) {
                            layer.closeTooltip();
                            const parentLayer = lineLayers[line.code];
                            if (parentLayer) {
                                parentLayer.eachLayer(l => l.setStyle(getLineStyle(conqueredLines.includes(line.code), line)));
                            }
                        });
                        layer.on('dblclick', e => { 
                            if (registerMode === 'line') {
                                L.DomEvent.stopPropagation(e); 
                                toggleLine(line.code); 
                            }
                        });
                    }
                }).addTo(map);
                lineLayers[line.code] = geojsonLayer;
                loadedPolylinesCount++; 
                
                if (loadedPolylinesCount >= totalPolylinesToLoad) {
                    checkAppReady();
                }
            }).catch(() => {
                loadedPolylinesCount++; 
                checkAppReady();
            });
        });

        loadStations();
    });
}

function getStationStyle(isClosed, zoom, isCheckIn) {
    if (currentMode === 'line-only') { return { opacity: 0, fillOpacity: 0, radius: 0, weight: 0 }; }
    let radius = 3.5, weight = 1.5, fillOpacity = 0.9, opacity = 0.9;

    if (zoom <= 7) {
        radius = isCheckIn ? 2 : 1; weight = isCheckIn ? 0.8 : 0; fillOpacity = isCheckIn ? 0.8 : 0.3;
    } else if (zoom <= 9) {
        radius = isCheckIn ? 2.5 : 1.5; weight = isCheckIn ? 1.2 : 0.5; fillOpacity = isCheckIn ? 0.9 : 0.5;
    } else if (zoom >= 13) {
        radius = 5; weight = 2.5;
    }

    if (currentMode === 'station-heavy' || currentMode === 'station-only') {
        fillOpacity = isCheckIn ? 1.0 : 0.6; opacity = isCheckIn ? 1.0 : 0.6;
        if (zoom <= 7) radius = isCheckIn ? 2.5 : 1.5; 
    }

    let markerColor = '#666a82', borderColor = '#2c2f42'; fillOpacity = 0.4; opacity = 0.4;

    if (isClosed) {
        if (isCheckIn) { markerColor = '#d49a00'; borderColor = '#ffcc00'; weight += 0.5; fillOpacity = 0.85; opacity = 0.85; } 
        else { markerColor = '#5c4600'; borderColor = '#332700'; fillOpacity = 0.4; opacity = 0.4; }
    } else {
        if (isCheckIn) { markerColor = '#b8becc'; borderColor = '#ffffff'; fillOpacity = 0.9; opacity = 0.9; }
    }
    return { radius: radius, fillColor: markerColor, color: borderColor, weight: weight, opacity: opacity, fillOpacity: fillOpacity };
}

function loadStations() {
    fetch(stationListUrl).then(response => response.json()).then(stations => {
        updateStatusText('駅情報読み込み中...');
        allStations = stations; 
        isStationsLoaded = true; 
        syncLegacyData();
        const currentZoom = map.getZoom();
        const checkStationSet = new Set(conqueredStations);

        stations.forEach(station => {
            const isClosed = station.closed === true;
            const tooltipName = isClosed ? `【廃駅】${station.name}` : station.name;
            const isCheckIn = checkStationSet.has(station.code);

            const marker = L.circleMarker([station.lat, station.lng], {
                ...getStationStyle(isClosed, currentZoom, isCheckIn),
                renderer: stationRenderer 
            });
            marker.isClosedStation = isClosed;
            marker.stationLines = station.lines || []; 
            marker.stationCode = station.code; 
            marker.isCheckIn = isCheckIn;
            
            marker.stationPref = getPrefCode(station);

            marker.bindTooltip(tooltipName, { sticky: true, direction: 'top', className: 'station-tooltip', offset: [0, -3] });
            
            marker.on('dblclick', (e) => {
                if (registerMode === 'station') {
                    L.DomEvent.stopPropagation(e);
                    toggleStationCheckIn(station.code);
                } else if (registerMode === 'pref') {
                    L.DomEvent.stopPropagation(e);
                    if (marker.stationPref) togglePrefectures(marker.stationPref);
                }
            });

            marker.addTo(stationLayerGroup);
        });

        updateStatusText('ボロノイ図生成中...');
        
        setTimeout(() => {
            stations.forEach(station => {
                if (station.voronoi) {
                    try {
                        const isCheckIn = checkStationSet.has(station.code);
                        const voronoiPoly = L.geoJSON(station.voronoi, { 
                            interactive: false,
                            renderer: voronoiRenderer, 
                            style: getVoronoiStyle(isCheckIn) 
                        });
                        voronoiPoly.stationCode = station.code;
                        voronoiLayerGroup.addLayer(voronoiPoly);
                    } catch(e) {
                        console.warn("ボロノイ図のパースに失敗:", station.code);
                    }
                }
            });

            isVoronoiLoaded = true;

            if (isVoronoiVisible) {
                updateStatusText('ボロノイ図マップ描画中...');
                setTimeout(() => {
                    voronoiLayerGroup.addTo(map);
                    checkAppReady();
                }, 50);
            } else {
                checkAppReady();
            }

        }, 50);

    }).catch(err => {
        console.error("駅データの読み込みに失敗しました:", err);
        isStationsLoaded = true;
        isVoronoiLoaded = true;
        checkAppReady();
    });
}

map.on('dblclick', function(e) {
    if (allStations.length === 0) return;
    if (registerMode === 'line' || registerMode === 'view') return; // 👁️ 眺めるモードの時はマップダブルクリックも無効化

    const clat = e.latlng.lat;
    const clng = e.latlng.lng;
    let minTarget = null;
    let minD2 = Infinity;

    for (let i = 0; i < allStations.length; i++) {
        const st = allStations[i];
        const dlat = clat - st.lat;
        const dlng = clng - st.lng;
        const d2 = dlat * dlat + dlng * dlng;
        if (d2 < minD2) {
            minD2 = d2;
            minTarget = st;
        }
    }

    if (minTarget) {
        if (registerMode === 'station') {
            toggleStationCheckIn(minTarget.code);
        } else if (registerMode === 'pref') {
            const pCode = getPrefCode(minTarget);
            if (pCode) togglePrefectures(pCode);
        }
    }
});

map.on('zoomend', function() {
    const currentZoom = map.getZoom();
    stationLayerGroup.eachLayer(marker => {
        marker.setStyle(getStationStyle(marker.isClosedStation, currentZoom, marker.isCheckIn));
    });
});

document.querySelectorAll('input[name="reg-mode"]').forEach(radio => {
    radio.addEventListener('change', function() {
        updateRegisterMode(this.value);
        refreshAllLines(); 
    });
});

document.querySelectorAll('input[name="view-mode"]').forEach(radio => {
    radio.addEventListener('change', function() {
        currentMode = this.value;
        refreshAllLines();
    });
});

document.getElementById('chk-invert').addEventListener('change', function() {
    isDisplayInverted = this.checked;
    refreshAllLines();
});

document.getElementById('chk-voronoi').addEventListener('change', function() {
    isVoronoiVisible = this.checked;
    localStorage.setItem('isVoronoiVisible', JSON.stringify(isVoronoiVisible));
    if (isVoronoiVisible) {
        voronoiLayerGroup.addTo(map);
        updateVoronoiStyles(); 
    } else {
        voronoiLayerGroup.removeFrom(map);
    }
});

document.getElementById('sidebar-search').addEventListener('input', () => { updateSidebarList(); });

const panel = document.getElementById('counter-panel');
const headerContainer = document.getElementById('top-right-header');
const prefPanel = document.getElementById('pref-panel');

document.getElementById('btn-panel-toggle').addEventListener('click', () => {
    panel.classList.remove('closed'); 
    headerContainer.style.display = 'none'; 
    prefPanel.classList.add('closed'); 
});
document.getElementById('btn-close-panel').addEventListener('click', () => {
    panel.classList.add('closed'); headerContainer.style.display = 'flex'; 
});

const sidebar = document.getElementById('sidebar');
document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
    if (sidebar.classList.contains('open')) { 
        sidebar.classList.remove('open'); 
    } else { 
        sidebar.classList.add('open'); 
        panel.classList.add('closed'); 
        headerContainer.style.display = 'flex'; 
        prefPanel.classList.add('closed'); 
    }
});
document.getElementById('btn-close-sidebar').addEventListener('click', () => sidebar.classList.remove('open'));

document.getElementById('mini-counter').addEventListener('click', (e) => {
    prefPanel.classList.toggle('closed');
    if (!prefPanel.classList.contains('closed')) {
        updatePrefPanel(); 
    }
});

document.getElementById('btn-pref-close').addEventListener('click', (e) => {
    prefPanel.classList.add('closed');
});

L.DomEvent.disableClickPropagation(prefPanel);
L.DomEvent.disableScrollPropagation(prefPanel);

const dataModal = document.getElementById('data-modal');
const modalTitle = document.getElementById('modal-window-title');
const modalDesc = document.getElementById('modal-window-desc');
const txtDataIO = document.getElementById('txt-data-io');
const btnModalExecute = document.getElementById('btn-modal-execute');
let modalMode = 'export'; 

function closeModal() {
    dataModal.classList.remove('open');
    txtDataIO.value = '';
}
document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);

document.getElementById('btn-export-show').addEventListener('click', () => {
    modalMode = 'export';
    modalTitle.textContent = '📥 データの書き出し (エクスポート)';
    modalDesc.textContent = '下のテキストボックスの内容をすべてコピーして、メモ帳などに保存してください。';
    
    const exportData = {
        lines: conqueredLines,
        stations: conqueredStations
    };
    
    txtDataIO.value = JSON.stringify(exportData, null, 2);
    
    btnModalExecute.textContent = '📋 クリップボードにコピー';
    btnModalExecute.className = 'btn-modal-action btn-modal-copy';
    
    panel.classList.add('closed'); 
    headerContainer.style.display = 'flex';
    dataModal.classList.add('open');
    
    setTimeout(() => { 
        txtDataIO.select(); 
        txtDataIO.setSelectionRange(0, 999999);
    }, 100);
});

document.getElementById('btn-import-show').addEventListener('click', () => {
    modalMode = 'import';
    modalTitle.textContent = '📤 データの読み込み (インポート)';
    modalDesc.textContent = '過去にエクスポートしたテキストを貼り付けて「データを復元する」を押してください。現在のデータは上書きされます。';
    txtDataIO.value = '';
    
    btnModalExecute.textContent = '⚙️ データを復元する';
    btnModalExecute.className = 'btn-modal-action';
    
    panel.classList.add('closed'); 
    headerContainer.style.display = 'flex';
    dataModal.classList.add('open');
});

btnModalExecute.addEventListener('click', () => {
    if (modalMode === 'export') {
        txtDataIO.select();
        txtDataIO.setSelectionRange(0, 999999); 
        
        let copySuccess = false;
        try {
            copySuccess = document.execCommand('copy');
        } catch (err) {
            copySuccess = false;
        }

        if (copySuccess) {
            alert('クリップボードにデータをコピーしました！');
            closeModal();
        } else if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(txtDataIO.value).then(() => {
                alert('クリップボードにデータをコピーしました！');
                closeModal();
            }).catch(err => {
                alert('コピーに失敗しました。枠内のテキストを手動でコピーしてください。');
            });
        } else {
            alert('お使いの環境では自動コピーがブロックされました。枠内のテキストを手動で全選択してコピーしてください。');
        }

    } else if (modalMode === 'import') {
        const rawText = txtDataIO.value.trim();
        if (!rawText) {
            alert('テキストが空です。');
            return;
        }
        
        try {
            const importedData = JSON.parse(rawText);
            if (!importedData || !Array.isArray(importedData.lines) || !Array.isArray(importedData.stations)) {
                throw new Error('データ構造が正しくありません。');
            }
            
            if (confirm(`路線データ: ${importedData.lines.length}件\n駅データ: ${importedData.stations.length}件\n\nこのデータをマップに読み込みますか？現在の記録は上書きされます。`)) {

                saveHistory();
                
                conqueredLines = importedData.lines;
                conqueredStations = importedData.stations;
                localStorage.setItem('conqueredLines', JSON.stringify(conqueredLines));
                localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations));
                
                refreshAllLines();
                
                alert('データのインポートが完了しました！');
                closeModal();
            }
        } catch (e) {
            alert('データの解析に失敗しました。正しいJSONテキストが入力されているか確認してください。\nエラー内容: ' + e.message);
        }
    }
});

document.getElementById('btn-reset').addEventListener('click', function() {
    if (confirm('すべての路線の制覇記録と駅のチェックイン記録をリセットしますか？')) {

        saveHistory();

        conqueredLines = []; conqueredStations = []; expandedLineCodes.clear(); 
        localStorage.setItem('conqueredLines', JSON.stringify(conqueredLines));
        localStorage.setItem('conqueredStations', JSON.stringify(conqueredStations));
        
        isVoronoiVisible = false;
        localStorage.setItem('isVoronoiVisible', JSON.stringify(isVoronoiVisible));
        document.getElementById('chk-voronoi').checked = false;
        voronoiLayerGroup.removeFrom(map);

        isDisplayInverted = false; document.getElementById('chk-invert').checked = false;
        currentMode = 'normal'; document.querySelectorAll('input[name="view-mode"]')[0].checked = true;
        
        // リセット時もデフォルトである「眺めるモード」に戻るように修正
        document.querySelectorAll('input[name="reg-mode"]')[3].checked = true;
        updateRegisterMode('view');

        prefPanel.classList.add('closed');
        refreshAllLines();
    }
});