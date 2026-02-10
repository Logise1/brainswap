// --- CONFIGURACIÓN & ESTADO ---
const CONFIG = {
    API_URL: 'https://greenbase.arielcapdevila.com',
    RTDB_URL: 'https://abuchat-4b8d6-default-rtdb.europe-west1.firebasedatabase.app/brainswap_audios.json',
    DETECTION_DELAY: 150, // ms
    SCAN_FREQ_BASE: 0.8,
    SCAN_FREQ_MAX: 1.5,
    TARGET_TOLERANCE: 0.15
};

// Global State
let state = {
    mode: 'IDLE', // IDLE, CALIBRATING, EXPERIENCING
    audioId: null, // ID del audio actual
    audioUrl: null, // URL blob o remoto
    calibratedThreshold: 0.22,
    headRotation: 0,
    centerOffset: 0, // Calibration center
    targetRotation: 0,
    isConnected: false,
    eyeOpenValues: [],
    eyeClosedValues: [],
    audioList: [],
    audioFinished: false // Flag for flow control
};

// AI & Video
let model = null;
let video = document.getElementById('webcam');
let canvas = document.getElementById('output'); // Canvas oculto para TFJS
let ctx = canvas.getContext('2d');
let calibCanvas = document.getElementById('calib-canvas');
let calibCtx = calibCanvas.getContext('2d');
let visCanvas = document.getElementById('visualizer');
let visCtx = visCanvas.getContext('2d');
let animationId = null;
let lastDetectionTime = 0;

// Audio Context
let audioCtx = null;
let masterGain = null;
let analyser = null;
// Nodos Voz
let voiceSource = null;
let voiceFilter = null;
let reverbNode = null;
// Nodos Scan
// Nodos Scan & Snap
let scanBuffer = null;
let snapBuffer = null;
let scanSource = null;
let scanGain = null;
let scanPanner = null; // Spatial Audio

// --- INICIALIZACIÓN ---
async function initApp() {
    await loadAI();
    await fetchAudioList();
    setupUI();
}
window.addEventListener('DOMContentLoaded', initApp);

async function loadAI() {
    try {
        await tf.ready();
        await tf.setBackend('webgl');
        const modelLoader = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;
        model = await faceLandmarksDetection.createDetector(modelLoader, {
            runtime: 'tfjs',
            refineLandmarks: false,
            maxFaces: 1
        });
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('home-screen').classList.remove('hidden');
    } catch (err) {
        console.error("AI Error:", err);
        alert("Error cargando IA. Recarga la página.");
    }
}

async function fetchAudioList() {
    try {
        const res = await fetch(CONFIG.RTDB_URL);
        const data = await res.json();
        if (data) {
            state.audioList = Object.values(data);
            console.log("Audios cargados:", state.audioList.length);
        }
    } catch (e) { console.warn("Error fetching audio list:", e); }
}

// --- NAVEGACIÓN UI ---
function switchScreen(id) {
    document.querySelectorAll('body > div').forEach(d => {
        if (d.id !== 'loading-screen' && d.id !== 'scan-line') d.classList.add('hidden');
    });
    document.getElementById(id).classList.remove('hidden');
}
function goHome() {
    stopExperience();
    switchScreen('home-screen');
}
function goToUpload() { switchScreen('upload-screen'); }

// --- LOGICA DE GRABACIÓN & SUBIDA ---
function setupUI() {
    const recordBtn = document.getElementById('record-btn');
    const stopBtn = document.getElementById('stop-btn');
    const preview = document.getElementById('audio-preview');
    const status = document.getElementById('record-status');
    const uploadBtn = document.getElementById('upload-btn');
    const pulse = document.getElementById('record-pulse');

    let mediaRecorder;
    let audioChunks = [];
    let recordedBlob = null;

    recordBtn.onclick = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
            mediaRecorder.onstop = () => {
                recordedBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const url = URL.createObjectURL(recordedBlob);
                preview.src = url;
                preview.classList.remove('hidden');

                uploadBtn.innerText = "TRANSMITIR MEMORIA";
                uploadBtn.disabled = false;

                status.innerText = "GRABACIÓN COMPLETADA";
                status.className = "text-green-500 font-mono text-xs tracking-wider";

                // Toggle UI back
                stopBtn.classList.add('hidden');
                recordBtn.classList.remove('hidden');
                pulse.classList.add('hidden');

                // Stop tracks
                stream.getTracks().forEach(t => t.stop());
            };

            mediaRecorder.start();
            status.innerText = "GRABANDO MEMORIA...";
            status.className = "text-red-500 font-mono text-xs tracking-wider animate-pulse";

            // Toggle UI
            recordBtn.classList.add('hidden');
            stopBtn.classList.remove('hidden');
            preview.classList.add('hidden');
            pulse.classList.remove('hidden');
            uploadBtn.disabled = true;

        } catch (e) {
            console.error(e);
            alert("Acceso al micrófono denegado.");
        }
    };

    stopBtn.onclick = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
    };

    uploadBtn.onclick = async () => {
        if (!recordedBlob) return;
        uploadBtn.innerText = "SUBIENDO...";
        uploadBtn.disabled = true;

        try {
            const formData = new FormData();
            const filename = `memory_${Date.now()}.webm`;
            formData.append('file', recordedBlob, filename);

            const res = await fetch(`${CONFIG.API_URL}/upload`, { method: 'POST', body: formData });
            if (!res.ok) throw new Error(await res.text());

            const data = await res.json();

            // Guardar referencia en RTDB
            await fetch(CONFIG.RTDB_URL, {
                method: 'POST',
                body: JSON.stringify({
                    id: data.id,
                    name: filename,
                    date: Date.now()
                })
            });

            document.getElementById('upload-status').innerText = "¡SUBIDA EXITOSA!";
            document.getElementById('upload-status').className = "text-green-500 font-mono text-sm";
            setTimeout(() => {
                uploadBtn.innerText = "TRANSMITIR A LA NUBE";
                uploadBtn.disabled = false;
                goHome();
                fetchAudioList(); // Recargar lista
            }, 1000);

        } catch (e) {
            console.error(e);
            uploadBtn.innerText = "ERROR - REINTENTAR";
            uploadBtn.disabled = false;
        }
    };
}

// --- CALIBRACIÓN ---
async function startCalibrationFlow() {
    switchScreen('calibration-screen');
    try {
        await setupCamera();
        // Ajustar canvas internos
        calibCanvas.width = video.videoWidth;
        calibCanvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        drawCalibrationLoop();
        waitForFace();
    } catch (e) {
        alert("Error cámara: " + e.message);
        goHome();
    }
}

async function waitForFace() {
    const txt = document.getElementById('calib-instruction');
    const indicator = document.getElementById('face-indicator');

    let faceFound = false;
    txt.innerText = "BUSCANDO ROSTRO...";

    while (!faceFound && document.getElementById('calibration-screen').classList.contains('hidden') === false) {
        const faces = await detectFaces();
        if (faces && faces.length > 0) {
            faceFound = true;
            indicator.style.backgroundColor = '#0f0';
            txt.innerText = "ROSTRO DETECTADO. MANTÉN LOS OJOS ABIERTOS.";
            document.getElementById('start-calib-btn').classList.remove('hidden');
        } else {
            indicator.style.backgroundColor = '#f00';
            await new Promise(r => setTimeout(r, 200));
        }
    }
}

function drawCalibrationLoop() {
    if (document.getElementById('calibration-screen').classList.contains('hidden')) return;

    // Draw Video & Debug Mesh
    calibCtx.drawImage(video, 0, 0, calibCanvas.width, calibCanvas.height);

    detectFaces().then(faces => {
        if (faces.length > 0) {
            const k = faces[0].keypoints;
            calibCtx.fillStyle = '#0f0';
            [33, 133, 362, 263, 1].forEach(i => {
                const p = k[i];
                if (p) calibCtx.fillRect(p.x - 2, p.y - 2, 4, 4);
            });
        }
    });

    requestAnimationFrame(drawCalibrationLoop);
}

async function runCalibration() {
    if (!audioCtx) initAudioGraph();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const bar = document.getElementById('calib-bar');
    const prog = document.getElementById('calib-progress');
    const txt = document.getElementById('calib-instruction');

    document.getElementById('start-calib-btn').classList.add('hidden');
    prog.classList.remove('hidden');
    state.eyeOpenValues = [];
    state.eyeClosedValues = [];

    // 1. Abiertos
    txt.innerText = "OJOS ABIERTOS...";
    for (let i = 0; i < 20; i++) {
        const faces = await detectFaces();
        if (faces && faces.length > 0) state.eyeOpenValues.push(getEAR(faces[0].keypoints));
        bar.style.width = `${(i / 40) * 100}%`;
        await new Promise(r => setTimeout(r, 100));
    }
    playBeep(600);

    // 2. Cerrados
    txt.innerText = "CIERRA LOS OJOS AHORA";
    txt.className = "text-red-500 text-lg font-bold mb-8 h-16 animate-pulse";
    await new Promise(r => setTimeout(r, 1500));

    for (let i = 0; i < 20; i++) {
        const faces = await detectFaces();
        if (faces && faces.length > 0) state.eyeClosedValues.push(getEAR(faces[0].keypoints));
        bar.style.width = `${50 + (i / 40) * 100}%`;
        await new Promise(r => setTimeout(r, 100));
    }

    // Calcular
    const avgOpen = state.eyeOpenValues.reduce((a, b) => a + b, 0) / state.eyeOpenValues.length || 0.3;

    // HEAD CALIBRATION
    const faces = await detectFaces();
    if (faces.length > 0) {
        const k = faces[0].keypoints;
        // Calibrate Yaw
        // Store current yaw as the "zero" point
        state.centerOffset = getYaw(k);
    }
    const avgClosed = state.eyeClosedValues.reduce((a, b) => a + b, 0) / state.eyeClosedValues.length || 0.15;

    // Weighted logic: Bias towards closed to prevent false positives when squinting
    state.calibratedThreshold = avgClosed + (avgOpen - avgClosed) * 0.45;

    console.log(`Calib: Open=${avgOpen.toFixed(3)}, Closed=${avgClosed.toFixed(3)}, Thresh=${state.calibratedThreshold.toFixed(3)}`);

    playBeep(1000);
    startExperience();
}

// --- EXPERIENCIA PRINCIPAL ---
async function startExperience() {
    switchScreen('experience-screen');
    state.mode = 'EXPERIENCING';
    state.isConnected = false;
    state.targetRotation = (Math.random() * 1.4) - 0.7; // -0.7 a 0.7 rads (~40 grados)

    // Seleccionar Audio
    // Seleccionar Audio Inicial
    pickRandomAudio();

    // Init Audio Context

    // Init Audio Context
    if (!audioCtx) initAudioGraph();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Reset Canvas
    visCanvas.width = window.innerWidth;
    visCanvas.height = window.innerHeight;

    // Start Loops
    state.audioId = null; // Reset audio playing flag
    ensureVoicePlaying(true); // Start immediately muffled

    loopDetection();
    loopVisualizer();
}

function stopExperience() {
    state.mode = 'IDLE';
    cancelAnimationFrame(animationId);
    stopAllAudio();
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
}

// --- CORE LOOPS ---

async function loopDetection() {
    if (state.mode !== 'EXPERIENCING') return;

    const now = Date.now();
    if (now - lastDetectionTime > CONFIG.DETECTION_DELAY) {
        lastDetectionTime = now;

        const faces = await detectFaces();
        updateGameLogic(faces);
    }

    animationId = requestAnimationFrame(loopDetection);
}

function updateGameLogic(faces) {
    const statusText = document.getElementById('status-text');
    const statusContainer = document.getElementById('status-container');
    const debugEar = document.getElementById('debug-ear');
    const debugRot = document.getElementById('debug-rot');

    if (!faces || faces.length === 0) {
        // Lost face logic
        return;
    }

    const k = faces[0].keypoints;
    const ear = getEAR(k);

    // HEAD ROTATION (Robust Yaw)
    // Uses face geometry relative to itself (Nose vs Cheeks)
    // Calibrated Rotation
    state.headRotation = getYaw(k) - (state.centerOffset || 0);

    debugEar.innerText = `EAR: ${ear.toFixed(3)}`;
    debugRot.innerText = `ROT: ${state.headRotation.toFixed(2)} | TGT: ${state.targetRotation.toFixed(2)}`;

    const isClosed = ear < state.calibratedThreshold;

    if (!isClosed) {
        // --- OJOS ABIERTOS ---
        statusContainer.style.opacity = '0';

        muffleVoice(true);
        stopScanSound();
        state.isConnected = false;

        // Hide visualizer
        document.body.classList.remove('visualizer-active');

        // RESET Logic: If audio finished and we opened eyes, prepare next.
        if (state.audioFinished) {
            state.audioFinished = false;
            pickRandomAudio();
        }

    } else {
        // --- OJOS CERRADOS ---
        statusContainer.style.opacity = '0';
        document.body.classList.add('visualizer-active');

        // Logic SIMPLIFICADA
        state.isConnected = true;
        muffleVoice(false);
        stopScanSound();

        // START AUDIO IF NEEDED
        if (!state.audioFinished) {
            ensureVoicePlaying(false); // Start Unmuffled (Clear)
        }
    }
}

function loopVisualizer() {
    if (state.mode !== 'EXPERIENCING') return;
    requestAnimationFrame(loopVisualizer);

    if (!analyser) return;

    // Solo dibujar si la "clase" visualizer-active está en body (ojos cerrados)
    if (!document.body.classList.contains('visualizer-active')) {
        visCtx.clearRect(0, 0, visCanvas.width, visCanvas.height);
        return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    visCtx.clearRect(0, 0, visCanvas.width, visCanvas.height);

    // Draw Bars or Waves
    const cx = visCanvas.width / 2;
    const cy = visCanvas.height / 2;
    const radius = Math.min(cx, cy) * 0.4;

    visCtx.beginPath();
    visCtx.strokeStyle = state.isConnected ? '#00ff00' : '#ffff00'; // Green if connected, Yellow searching
    visCtx.lineWidth = 2;

    for (let i = 0; i < bufferLength; i += 10) { // Skip bins for optimization
        const v = dataArray[i] / 255;
        const h = v * 100;
        const angle = (i / bufferLength) * Math.PI * 2;

        const x1 = cx + Math.cos(angle) * radius;
        const y1 = cy + Math.sin(angle) * radius;
        const x2 = cx + Math.cos(angle) * (radius + h);
        const y2 = cy + Math.sin(angle) * (radius + h);

        visCtx.moveTo(x1, y1);
        visCtx.lineTo(x2, y2);
    }
    visCtx.stroke();

    // Inner Circle Pulse
    if (state.isConnected) {
        visCtx.beginPath();
        visCtx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
        visCtx.fillStyle = `rgba(0, 255, 0, ${0.1 + (Math.random() * 0.1)})`;
        visCtx.fill();
    }
}

// --- AUDIO GRAPH ---
function initAudioGraph() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Voice Filter chain
    voiceFilter = audioCtx.createBiquadFilter();
    voiceFilter.type = 'lowpass';
    voiceFilter.frequency.value = 400;

    // Convolution Reverb
    const len = audioCtx.sampleRate * 3;
    const buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for (let c = 0; c < 2; c++) {
        for (let i = 0; i < len; i++) {
            buf.getChannelData(c)[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        }
    }
    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = buf;

    // Load Scan Sound
    loadScanSound();
    loadSnapSound();

    // Create nodes for scan
    scanGain = audioCtx.createGain();
    scanGain.gain.value = 0;
    scanPanner = audioCtx.createStereoPanner();
    scanGain.connect(scanPanner);
    scanPanner.connect(masterGain);
}

async function loadScanSound() {
    try {
        const r = await fetch('scan.mp3');
        const ab = await r.arrayBuffer();
        scanBuffer = await audioCtx.decodeAudioData(ab);
    } catch (e) { console.error("Missing scan.mp3"); }
}

async function loadSnapSound() {
    try {
        const r = await fetch('snap.mp3');
        const ab = await r.arrayBuffer();
        snapBuffer = await audioCtx.decodeAudioData(ab);
    } catch (e) { console.warn("Missing snap.mp3, using synthesis."); }
}

async function ensureVoicePlaying(startMuffled) {
    if (voiceSource) return;

    // Crear buffer del audio
    let buffer;

    if (state.audioUrl) {
        try {
            const resp = await fetch(state.audioUrl);
            const ab = await resp.arrayBuffer();
            buffer = await audioCtx.decodeAudioData(ab);
        } catch (e) {
            console.error("Audio load fail", e);
            buffer = createNoiseBuffer();
        }
    } else {
        buffer = createNoiseBuffer();
    }

    voiceSource = audioCtx.createBufferSource();
    voiceSource.buffer = buffer;
    voiceSource.loop = false; // Don't loop
    voiceSource.onended = () => {
        playSnapSound();
        state.audioFinished = true;
        voiceSource = null;
    };

    // Graph: Source -> Filter -> (Dry + Reverb) -> Master

    // CLEANUP GLOBAL NODES to prevent volume accumulation
    voiceFilter.disconnect();
    reverbNode.disconnect();

    const dry = audioCtx.createGain(); dry.gain.value = 0.8;
    const wet = audioCtx.createGain(); wet.gain.value = 0.4;

    voiceSource.connect(voiceFilter);
    voiceFilter.connect(dry);
    voiceFilter.connect(reverbNode);
    reverbNode.connect(wet);

    dry.connect(masterGain);
    wet.connect(masterGain);

    voiceSource.start();

    muffleVoice(startMuffled);
}

function createNoiseBuffer() {
    const b = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 0.2;
    return b;
}

function muffleVoice(shouldMuffle) {
    if (!voiceFilter) return;
    const target = shouldMuffle ? 300 : 20000;
    voiceFilter.frequency.setTargetAtTime(target, audioCtx.currentTime, 0.3);
}

function playScanSound(proximity, direction) {
    if (!scanBuffer) return;
    if (!scanSource) {
        scanSource = audioCtx.createBufferSource();
        scanSource.buffer = scanBuffer;
        scanSource.loop = true;
        scanSource.connect(scanGain);
        scanSource.start();
    }

    // Volume Adjustment
    scanGain.gain.setTargetAtTime(0.4, audioCtx.currentTime, 0.1);

    // Pitch (Frequency) Adjustment based on proximity (closer = higher pitch/faster)
    const rate = CONFIG.SCAN_FREQ_BASE + (proximity * (CONFIG.SCAN_FREQ_MAX - CONFIG.SCAN_FREQ_BASE));
    scanSource.playbackRate.setTargetAtTime(rate, audioCtx.currentTime, 0.1);

    // Spatial Audio (Panning)
    // direction > 0 => Target Right. Pan to Right (1).
    // direction < 0 => Target Left. Pan to Left (-1).
    // Clamp between -1 and 1
    const panVal = Math.max(-1, Math.min(1, direction * 2));
    scanPanner.pan.setTargetAtTime(panVal, audioCtx.currentTime, 0.1);
}

function stopScanSound() {
    if (scanGain) scanGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2);
    if (scanSource) {
        scanSource.stop(audioCtx.currentTime + 0.3);
        scanSource = null;
    }
}

function stopAllAudio() {
    if (masterGain) masterGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
    setTimeout(() => {
        if (voiceSource) { try { voiceSource.stop() } catch (e) { }; voiceSource = null; }
        if (scanSource) { try { scanSource.stop() } catch (e) { }; scanSource = null; }
        if (masterGain) masterGain.gain.value = 1;
    }, 300);
}

function playBeep(f) {
    if (!audioCtx) initAudioGraph();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = f;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.1);
}

function playConnectionSound() {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.1);
    g.gain.setValueAtTime(0.5, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    o.connect(g); g.connect(masterGain);
    o.start(); o.stop(audioCtx.currentTime + 0.5);
}

// --- UTIL ---
async function setupCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
    });
    video.srcObject = stream;
    return new Promise(resolve => {
        video.onloadedmetadata = () => {
            // FIX: Explicitly tell TFJS the video dimensions
            video.width = video.videoWidth;
            video.height = video.videoHeight;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            video.play();
            resolve();
        };
    });
}

async function detectFaces() {
    if (!model || video.readyState < 2) return [];
    try {
        const faces = await model.estimateFaces(video);
        return faces;
    } catch (e) {
        console.warn("Detection glitch:", e);
        return [];
    }
}

function getEAR(k) {
    // MediaPipe Keypoints: 33,133 left eye; 362,263 right eye
    // 159,145 left vertical; 386,374 right vertical
    const lV = dist(k[159], k[145]);
    const lH = dist(k[33], k[133]);
    const rV = dist(k[386], k[374]);
    const rH = dist(k[362], k[263]);
    return ((lV / lH) + (rV / rH)) / 2;
}
function dist(a, b) { return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)); }

function getYaw(k) {
    // 454 (Left Cheek), 234 (Right Cheek), 1 (Nose Tip)
    const left = k[454] || k[33];
    const right = k[234] || k[263];
    const nose = k[1];

    if (!left || !right || !nose) return 0;

    const mid = (left.x + right.x) / 2;
    const width = Math.abs(left.x - right.x);

    return ((nose.x - mid) / width) * 1.5; // Lower sensitivity = More rotation required
}

function pickRandomAudio() {
    if (state.audioList.length > 0) {
        const item = state.audioList[Math.floor(Math.random() * state.audioList.length)];
        state.audioUrl = `${CONFIG.API_URL}/file/${item.id}`;
        console.log("Next Audio:", item.name);
    } else {
        state.audioUrl = null;
    }
}

function playSnapSound() {
    if (!audioCtx) return;

    // Use File if available
    if (snapBuffer) {
        const src = audioCtx.createBufferSource();
        src.buffer = snapBuffer;
        src.connect(masterGain);
        src.start();
        return;
    }

    // Fallback: Synthesize Snap
    const t = audioCtx.currentTime;
    const gain = audioCtx.createGain();

    // High-pass filtered noise for "Snap" character
    const bufferSize = audioCtx.sampleRate * 0.05; // 50ms
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 4);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1000;

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    gain.gain.setValueAtTime(1, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.05);
    noise.start(t);
}
