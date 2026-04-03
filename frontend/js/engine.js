// clock.js - Watch display module
const ClockModule = (function() {
    let currentMode = 'quartz'; 
    let requestRef;
    let isMaximized = false;
    
    // --- CALCULATOR STATE ---
    let calcState = { display: '0', operator: null, firstOperand: null, waitingForNewValue: false, isCalcMode: false };
    function loadCalcState() { const saved = localStorage.getItem('ironclad_calc_state'); if (saved) { try { calcState = JSON.parse(saved); } catch(e) {} } }
    function saveCalcState() { localStorage.setItem('ironclad_calc_state', JSON.stringify(calcState)); }

    // --- CASIOTRON TRN-50 STATE ---
    const worldCities = [
        { code: 'TYO', offset: 9 }, { code: 'LON', offset: 0 }, { code: 'NYC', offset: 1 }, 
        { code: 'LAX', offset: -4 }, { code: 'SYD', offset: -7 }, { code: 'DXB', offset: 11 }
    ];

    let casiotronState = {
        mode: 0, // 0: TIME, 1: WT, 2: STW, 3: TMR, 4: ALM
        is24h: false,
        isAdjusting: false,
        isMuted: false, 
        sig: false, // NEW: Hourly Chime (Signal)
        lastChimeHour: -1, // Guard to prevent multiple chimes in the same second
        wtIndex: 0,
        stw: { running: false, start: 0, elapsed: 0, isSplit: false, splitTime: 0 }, // NEW: Split properties
        tmr: { running: false, end: 0, remaining: 10 * 60 * 1000, default: 10 * 60 * 1000, isAlerting: false },
        alm: { active: false, hours: 12, minutes: 0, isAlerting: false },
        light: false,
        blinkFlag: true
    };

    // Load saved settings from LocalStorage
    function loadCasiotronState() {
        const saved = localStorage.getItem('ironclad_casiotron_state');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                // We safely merge so we don't break timers if running
                casiotronState.mode = parsed.mode ?? 0;
                casiotronState.is24h = parsed.is24h ?? false;
                casiotronState.isMuted = parsed.isMuted ?? false; 
                casiotronState.sig = parsed.sig ?? false; // Load hourly chime state
                casiotronState.wtIndex = parsed.wtIndex ?? 0;
                casiotronState.tmr.default = parsed.tmr?.default ?? 10 * 60 * 1000;
                casiotronState.tmr.remaining = parsed.tmr?.remaining ?? 10 * 60 * 1000;
                casiotronState.alm.hours = parsed.alm?.hours ?? 12;
                casiotronState.alm.minutes = parsed.alm?.minutes ?? 0;
                casiotronState.alm.active = parsed.alm?.active ?? false;
            } catch(e) {}
        }
    }
    
    function saveCasiotronState() {
        localStorage.setItem('ironclad_casiotron_state', JSON.stringify(casiotronState));
    }

    loadCasiotronState(); // Call immediately on load

    setInterval(() => { casiotronState.blinkFlag = !casiotronState.blinkFlag; }, 500);

    // --- CASIO BEEP SYNTHESIZER ---
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    function playCasioBeep(type = 'normal') {
        // If button beeps are muted, ignore normal beeps (alarms/chimes still sound)
        if (type === 'normal' && casiotronState.isMuted) return;

        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        // Classic Casio sound is a high square wave
        osc.type = 'square';
        
        if (type === 'normal') {
            osc.frequency.setValueAtTime(4000, audioCtx.currentTime); // 4kHz
            gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.05);
        } else if (type === 'alarm') {
            // Alarm / Chime sound: two rapid beeps
            osc.frequency.setValueAtTime(4000, audioCtx.currentTime);
            gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime + 0.1);
            gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime + 0.15);
            gainNode.gain.setValueAtTime(0, audioCtx.currentTime + 0.25);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.25);
        }
    }
    
    // Function to handle continuous alarms
    let alarmInterval = null;
    function triggerAlarm() {
        if (alarmInterval) return;
        let count = 0;
        alarmInterval = setInterval(() => {
            playCasioBeep('alarm');
            count++;
            if (count > 10) { // Beeps 10 times then auto-stops
                clearInterval(alarmInterval);
                alarmInterval = null;
            }
        }, 500);
    }
    
    function stopAlarm() {
        if (alarmInterval) {
            clearInterval(alarmInterval);
            alarmInterval = null;
        }
    }
    
    // --- SOLAR LIGHT ENGINE (SUN PATH SIMULATOR) ---
    let userLocation = { lat: -29.9045, lon: -71.2489 }; // Default: La Serena
    let lastSunUpdate = 0; 
    
    function requestLocation() {
        if ("geolocation" in navigator) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    userLocation.lat = position.coords.latitude;
                    userLocation.lon = position.coords.longitude;
                    console.log("Ironclad Sun Engine: Using real coordinates.", userLocation);
                    // Force immediate update when getting location
                    updateSunlightReflection(new Date(), true); 
                },
                (error) => { console.log("Ironclad Sun Engine: Using default coordinates."); }
            );
        }
    }

    function calculateSunPosition(date, lat, lon) {
        const PI = Math.PI;
        const rad = PI / 180;
        const start = new Date(date.getFullYear(), 0, 0);
        const diff = date - start;
        const oneDay = 1000 * 60 * 60 * 24;
        const dayOfYear = Math.floor(diff / oneDay);
        const declination = -23.45 * Math.cos(rad * (360 / 365) * (dayOfYear + 10));
        const tzOffset = date.getTimezoneOffset() / 60; 
        const localTime = date.getHours() + (date.getMinutes() / 60) + (date.getSeconds() / 3600);
        const solarTime = localTime + (lon / 15) + tzOffset;
        const hourAngle = 15 * (solarTime - 12);
        
        const sinElevation = Math.sin(lat * rad) * Math.sin(declination * rad) + Math.cos(lat * rad) * Math.cos(declination * rad) * Math.cos(hourAngle * rad);
        const elevation = Math.asin(sinElevation) / rad;
        
        let azimut = Math.acos( (Math.sin(declination * rad) - Math.sin(lat * rad) * Math.sin(elevation * rad)) / (Math.cos(lat * rad) * Math.cos(elevation * rad)) ) / rad;
        if (hourAngle > 0) { azimut = 360 - azimut; }
        
        return { elevation, azimut };
    }

    function updateSunlightReflection(now, force = false) {
        if (!force && now.getTime() - lastSunUpdate < 5000) return; 
        lastSunUpdate = now.getTime();

        const sun = calculateSunPosition(now, userLocation.lat, userLocation.lon);
        
        let intensity1 = 0;
        let intensity2 = 0;

        if (sun.elevation > 0) {
            const normalizationFactor = Math.min(sun.elevation / 20, 1);
            intensity1 = 0.4 * normalizationFactor;
            intensity2 = 0.1 * normalizationFactor;
        } 

        let lightAngleCSS = sun.azimut - 180;
        
        const radAzimut = (sun.azimut - 90) * (Math.PI / 180);
        const dist = 50 - Math.min(sun.elevation, 50); 
        const xPercent = 50 + (Math.cos(radAzimut) * dist);
        const yPercent = 50 + (Math.sin(radAzimut) * dist);

        document.documentElement.style.setProperty('--light-angle', `${lightAngleCSS}deg`);
        document.documentElement.style.setProperty('--light-intensity-1', intensity1);
        document.documentElement.style.setProperty('--light-intensity-2', intensity2);
        document.documentElement.style.setProperty('--light-x', `${xPercent}%`);
        document.documentElement.style.setProperty('--light-y', `${yPercent}%`);
    }

    // --- DYNAMIC CATALOG ---
    const WATCH_CATALOG = {
        quartz: {
            desc: 'Quartz Module 1Hz<br>Cushion Case',
            isDigital: false, bph: null, hideMarkers: [3],
            template: `<div class="watch-crown"></div><div class="watch-face"><div class="inner-bezel"></div><div id="hour-markers"></div><div class="watch-brand">Ironclad</div><div class="watch-model">QUARTZ</div><div class="watch-specs">WR 100M<br>FULL IRON</div><div class="date-window"><span class="date-number" id="date-display">--</span></div><div class="hands-container"><div class="hand-hour" id="hand-hour"></div><div class="hand-minute" id="hand-minute"></div><div class="hand-second" id="hand-second"></div><div class="center-pin"></div></div><div class="glass-reflection"></div></div>`
        },
        casiotron: {
            desc: 'TRN-50 50th Anniversary<br>Tough Solar & Multi-Mode',
            isDigital: true,
            hideMarkers: [],
            template: `
                <div class="casio-btn btn-a" data-btn="A"></div> <div class="casio-btn btn-b" data-btn="B"></div> <div class="casio-btn btn-c" data-btn="C"></div> <div class="casio-btn btn-d" data-btn="D"></div> <div class="casiotron-bezel"></div>
                <div class="casiotron-dial-container">
                    <div class="casiotron-dial-pattern"></div>
                        <div class="casiotron-gold-ring">

                            <div class="casiotron-logo">CASIO</div>

                            <div class="casiotron-lcd-frame">
                                <div class="casiotron-lcd" id="casiotron-lcd">
                                    <div class="casio-top-row">
                                        <span class="casio-ps">PS</span>
                                        <span class="casio-date-matrix" id="casio-header"><strong class="casiotron-day">SU</strong>6.30</span>
                                    </div>
                                    <div class="casio-indicators-row">
                                        <span>LT</span><span id="casio-ind-1" class="active">RCVD</span><span>TMR</span><span>ALM</span><span>SIG</span><span id="casio-ind-mute">MUTE</span><span class="casio-red">LOW</span>
                                    </div>
                                    <div class="casio-bottom-row">
                                        <span class="casio-pm" id="casio-pm">P</span>
                                        <span class="casio-main" id="casio-main">10:58</span>
                                        <span class="casio-sec" id="casio-sec">50</span>
                                    </div>
                                </div>
                            </div>
                            <div class="casiotron-model">
                                CASIOTRON
                                <div class="casiotron-sublogo">TRN-50 ANNIVERSARY</div>
                                <br>
                            </div>
                        </div>
                    </div>
                    <span class="casiotron-japan">JAPAN</span>
                </div>
                <div class="glass-reflection casiotron-glass"></div>
            `,
            onMount: function () {
                let pressTimer = null;
                let isLongPress = false;

                // Logical mapping of physical buttons
                document.querySelectorAll('.casio-btn').forEach(btn => {
                    btn.addEventListener('pointerdown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // --- FIX PARA LOS BORDES DEL BOTÓN ---
                        // "Captura" el puntero. Obliga al navegador a mandar los eventos a este botón
                        // aunque la animación CSS lo aleje del cursor físico.
                        if (e.pointerId) {
                            e.target.setPointerCapture(e.pointerId);
                        }
                        // If an alarm/timer is sounding, ANY button stops it
                        if (casiotronState.alm.isAlerting || casiotronState.tmr.isAlerting) {
                            stopAlarm();
                            casiotronState.alm.isAlerting = false;
                            
                            // Reset timer to original time visually
                            if (casiotronState.tmr.isAlerting) {
                                casiotronState.tmr.isAlerting = false;
                                casiotronState.tmr.remaining = casiotronState.tmr.default;
                            }
                            
                            saveCasiotronState(); // Save state
                            return; // Do not execute normal button action
                        }

                        const id = e.target.dataset.btn;
                        playCasioBeep('normal'); // All buttons beep when pressed (unless muted)

                        // --- LONG PRESS SETUP FOR TIMER RESET (BUTTON D) ---
                        if (id === 'D' && casiotronState.mode === 3 && !casiotronState.isAdjusting) {
                            isLongPress = false;
                            pressTimer = setTimeout(() => {
                                isLongPress = true;
                                casiotronState.tmr.running = false;
                                casiotronState.tmr.remaining = casiotronState.tmr.default;
                                playCasioBeep('normal'); // Second beep to confirm reset!
                                saveCasiotronState();
                            }, 3000); // 3 seconds hold
                            return; // Wait for pointerup to do the short press
                        }

                        if (id === 'C') { // --- BUTTON C: MODE ---
                            if (casiotronState.isAdjusting) {
                                // Ignore or toggle parameter to adjust (simplified)
                            } else {
                                casiotronState.mode = (casiotronState.mode + 1) % 5;
                            }
                        }

                        else if (id === 'D') { // --- BUTTON D: START/STOP/PLUS ---
                            if (casiotronState.mode === 0 && !casiotronState.isAdjusting) {
                                // TIME: Toggle 12H/24H
                                casiotronState.is24h = !casiotronState.is24h;
                            } else if (casiotronState.mode === 1) {
                                // WT: Change City
                                casiotronState.wtIndex = (casiotronState.wtIndex + 1) % worldCities.length;
                            } else if (casiotronState.mode === 2) {
                                // STW: Play/Pause
                                if (casiotronState.stw.running) {
                                    casiotronState.stw.running = false;
                                    casiotronState.stw.elapsed += Date.now() - casiotronState.stw.start;
                                } else {
                                    casiotronState.stw.running = true;
                                    casiotronState.stw.start = Date.now();
                                }
                            } else if (casiotronState.mode === 3) {
                                // TMR Adjusting
                                if (casiotronState.isAdjusting) {
                                    // Add 1 minute to Timer
                                    casiotronState.tmr.default += 60 * 1000;
                                    if (casiotronState.tmr.default > 60 * 60 * 1000) casiotronState.tmr.default = 60 * 1000; // Max 60 mins
                                    casiotronState.tmr.remaining = casiotronState.tmr.default;
                                }
                            } else if (casiotronState.mode === 4) {
                                // ALM Adjusting or Cycle
                                if (casiotronState.isAdjusting) {
                                    casiotronState.alm.hours = (casiotronState.alm.hours + 1) % 24;
                                } else {
                                    // CYCLE ALARM & SIG (Chime) exactly like real Casio:
                                    // OFF/OFF -> ALM ON -> SIG ON -> BOTH ON -> OFF/OFF
                                    if (!casiotronState.alm.active && !casiotronState.sig) {
                                        casiotronState.alm.active = true;
                                    } else if (casiotronState.alm.active && !casiotronState.sig) {
                                        casiotronState.alm.active = false;
                                        casiotronState.sig = true;
                                    } else if (!casiotronState.alm.active && casiotronState.sig) {
                                        casiotronState.alm.active = true;
                                    } else {
                                        casiotronState.alm.active = false;
                                        casiotronState.sig = false;
                                    }
                                }
                            }
                        }

                        else if (id === 'A') { // --- BUTTON A: ADJUST/RESET/SPLIT/MUTE ---
                            if (casiotronState.mode === 0) {
                                // TIME Mode: Toggle MUTE
                                casiotronState.isMuted = !casiotronState.isMuted;
                            } else if (casiotronState.mode === 2) {
                                // STW: Split / Reset Logic
                                if (casiotronState.stw.running) {
                                    // If running, A acts as SPLIT toggle
                                    casiotronState.stw.isSplit = !casiotronState.stw.isSplit;
                                    if (casiotronState.stw.isSplit) {
                                        // Save the exact freeze time
                                        casiotronState.stw.splitTime = casiotronState.stw.elapsed + (Date.now() - casiotronState.stw.start);
                                    }
                                } else {
                                    // If stopped, A acts as CLEAR
                                    if (casiotronState.stw.isSplit) {
                                        casiotronState.stw.isSplit = false; // Reveal stopped total time
                                    } else {
                                        casiotronState.stw = { running: false, start: 0, elapsed: 0, isSplit: false, splitTime: 0 };
                                    }
                                }
                            } else if (casiotronState.mode === 3 || casiotronState.mode === 4) {
                                // TMR and ALM: Enter/Exit adjust mode
                                casiotronState.isAdjusting = !casiotronState.isAdjusting;
                            }
                        }

                        else if (id === 'B') { // --- BUTTON B: LIGHT ---
                            casiotronState.light = true;
                            setTimeout(() => casiotronState.light = false, 2000);
                        }
                        
                        saveCasiotronState(); // Persist changes
                    });

                    // POINTER END HANDLERS FOR SHORT PRESS ON LONG-PRESSABLE BUTTONS
                    const handlePointerEnd = (e) => {
                        const id = e.target.dataset.btn;
                        if (id === 'D' && casiotronState.mode === 3 && !casiotronState.isAdjusting) {
                            if (pressTimer) {
                                clearTimeout(pressTimer);
                                pressTimer = null;
                            }
                            if (e.type === 'pointerup' && !isLongPress) {
                                if (casiotronState.tmr.running) {
                                    casiotronState.tmr.running = false;
                                    casiotronState.tmr.remaining = casiotronState.tmr.end - Date.now();
                                } else {
                                    casiotronState.tmr.running = true;
                                    casiotronState.tmr.end = Date.now() + casiotronState.tmr.remaining;
                                }
                                saveCasiotronState();
                            }
                        }
                    };

                    btn.addEventListener('pointerup', handlePointerEnd);
                    btn.addEventListener('pointerleave', handlePointerEnd);
                    btn.addEventListener('pointerout', handlePointerEnd);
                });
            }
        },
        submariner: {
            desc: 'Swiss GMT Chronometer 28800 BPH<br>Bicolor Ceramic Bezel',
            isDigital: false,
            bph: 28800,
            hideMarkers: [3],
            template: `
                <div class="watch-crown submariner-crown"></div>
                <div class="submariner-bezel">
                    <div id="gmt-bezel-numbers" class="gmt-numbers"></div>
                </div>
                
                <div class="watch-face submariner-face">
                    <div id="hour-markers"></div>
                    <div class="watch-brand submariner-brand">ROLEX</div>
                    <div class="watch-model submariner-model">OYSTER PERPETUAL IRON</div>
                    <div class="watch-specs submariner-specs"><div class="r">SUBMARINER</div>1000ft = 300<span style="font-style:italic">m</span><br>SUPERLATIVE CHRONOMETER<br>OFFICIALLY CERTIFIED</div>
                    <div class="date-window submariner-date"><span class="date-number" id="date-display">--</span></div>
                    
                    <div class="hands-container">
                        <div class="hand-hour submariner-hour" id="hand-hour"><div class="mercedes-circle"></div></div>
                        <div class="hand-minute submariner-minute" id="hand-minute"></div>
                        <div class="hand-second submariner-second" id="hand-second"></div>
                        <div class="center-pin submariner-pin"></div>
                    </div>
                </div>
                <div class="glass-reflection"></div>
                <div class="submariner-cyclops"></div>
            `,
            onMount: function () {
                const gmtContainer = document.getElementById('gmt-bezel-numbers');
                if (!gmtContainer) return;

                const gmtMarks = [
                    '▼', '▮', '1', '▮', '2', '▮', '3', '',
                    '4', '', '5', '', '6', '', '7', '',
                    '8', '', '9', '', '10', '', '11', ''
                ];

                gmtContainer.innerHTML = '';

                gmtMarks.forEach((mark, index) => {
                    const numDiv = document.createElement('div');
                    numDiv.className = 'gmt-num';
                    numDiv.style.transform = `rotate(${index * 15}deg)`;

                    const innerSpan = document.createElement('span');
                    innerSpan.textContent = mark;

                    if (mark === '▮') {
                        innerSpan.className = 'gmt-dot';
                    } else if (mark === '■') {
                        innerSpan.className = 'gmt-dot-thick';
                    }

                    numDiv.appendChild(innerSpan);
                    gmtContainer.appendChild(numDiv);
                });

                const bezelElement = document.querySelector('.submariner-bezel');
                if (!bezelElement) return;

                let currentRotation = parseFloat(localStorage.getItem('ironclad_submariner_bezel')) || 0;
                bezelElement.style.transform = `rotate(${currentRotation}deg)`;

                const rotateBezel = (degrees) => {
                    currentRotation += degrees;
                    if (currentRotation <= -360) currentRotation = 0;

                    bezelElement.style.transform = `rotate(${currentRotation}deg)`;
                    localStorage.setItem('ironclad_submariner_bezel', currentRotation);
                };

                bezelElement.addEventListener('mousedown', (e) => {
                    e.stopPropagation(); 
                    rotateBezel(-15); 
                });

                bezelElement.addEventListener('touchstart', (e) => {
                    e.preventDefault(); 
                    e.stopPropagation();
                    rotateBezel(-15);
                }, { passive: false });
            }
        },
        automatic: {
            desc: 'Mechanical Module 18800 BPH<br>Open Heart Case',
            isDigital: false, bph: 18800, hideMarkers: [3, 6],
            template: `<div class="watch-crown"></div><div class="watch-face"><div class="inner-bezel"></div><div id="hour-markers"></div><div class="watch-brand">Ironclad</div><div class="watch-model">AUTOMATIC</div><div class="watch-specs">24 JEWELS<br>SAPPHIRE<br>jap mov</div></div></div><div class="date-window"><span class="date-number" id="date-display">--</span></div><div class="hands-container"><div class="hand-hour" id="hand-hour"></div><div class="hand-minute" id="hand-minute"></div><div class="hand-second" id="hand-second"></div><div class="center-pin"></div></div><div class="glass-reflection"></div></div>`
        },
        grandseiko: {
            desc: 'Hi-Beat 36000 BPH<br>Zaratsu Polish & Dauphine Hands',
            isDigital: false,
            bph: 36000, // 10 saltos exactos por segundo (Hi-Beat)
            hideMarkers: [3],
            template: `
                <div class="watch-crown gs-crown"></div>
                <div class="gs-bezel"></div>
                
                <div class="watch-face gs-face">
                    <div class="gs-texture"></div>
                    
                    <div id="hour-markers"></div>
                    
                    <div class="watch-brand gs-brand">GS<br><span class="gs-sub">grand seiko</span></div>
                    <div class="watch-specs gs-specs">HI-BEAT 36000 <div class="gs-specs-red">GMT</div></div>
                    
                    <div class="date-window gs-date"><span class="date-number" id="date-display">--</span></div>
                    
                    <div class="hands-container">
                        <div class="hand-hour gs-hour" id="hand-hour"></div>
                        <div class="hand-minute gs-minute" id="hand-minute"></div>
                        <div class="hand-second gs-second" id="hand-second"></div>
                        <div class="center-pin gs-pin"></div>
                    </div>
                </div>
                <div class="glass-reflection"></div>
            `
        },
        vostok: {
            desc: 'Russian Diver 19800 BPH<br>Domed Acrylic Crystal',
            isDigital: false, bph: 19800, hideMarkers: [3],
            template: `<div class="watch-crown vostok-crown"></div><div class="watch-face vostok-face"><div id="hour-markers"></div><div class="watch-brand vostok-brand">IRONCLAD</div><div class="watch-model vostok-model">AMPHIBIA</div><div class="watch-specs vostok-specs">200M<br>31 JEWELS</div><div class="date-window vostok-date"><span class="date-number" id="date-display">--</span></div><div class="hands-container"><div class="hand-hour vostok-hour" id="hand-hour"></div><div class="hand-minute vostok-minute" id="hand-minute"></div><div class="hand-second vostok-second" id="hand-second"></div><div class="center-pin vostok-pin"></div></div></div><div class="glass-reflection domed-acrylic"></div>`
        },
        sbsa255: {
            desc: 'Seiko 5 Sports JDM 21600 BPH<br>37.4mm Field/Diver Case',
            isDigital: false, bph: 21600, hideMarkers: [3],
            template: `<div class="watch-crown sbsa-crown"></div><div class="sbsa-bezel"></div><div class="watch-face sbsa-face"><div id="hour-markers"></div><div class="watch-brand sbsa-brand"><span class="sbsa-5">SEIKO SPORT</span></div><div class="watch-model sbsa-model">FULL IRON<br>AUTOMATIC<br><div></div></div><div class="watch-specs sbsa-specs"><div class="gs-specs-red">100M WR</div>MADE IN JAPAN</div><div class="date-window sbsa-date"><span class="date-number" id="date-display">--</span></div><div class="hands-container"><div class="hand-hour sbsa-hour" id="hand-hour"></div><div class="hand-minute sbsa-minute" id="hand-minute"></div><div class="hand-second sbsa-second" id="hand-second"></div><div class="center-pin sbsa-pin"></div></div></div><div class="glass-reflection"></div>`
        },
        seaclad: {
            desc: 'Co-Axial Master 25200 BPH<br>Wave Dial & Helium Valve',
            isDigital: false, bph: 25200, hideMarkers: [6], 
            template: `<div class="watch-crown seaclad-crown"></div></div><div class="seaclad-bezel"></div><div class="watch-face seaclad-face"><div class="seaclad-waves"></div><div id="hour-markers"></div><div class="watch-brand seaclad-brand">IRONCLAD</div><div class="watch-model seaclad-model">SEACLAD<br>PROFESSIONAL</div><div class="watch-specs seaclad-specs">CO-AXIAL MASTER<br>300m / 1000ft</div><div class="date-window seaclad-date"><span class="date-number" id="date-display">--</span></div><div class="hands-container"><div class="hand-hour seaclad-hour" id="hand-hour"></div><div class="hand-minute seaclad-minute" id="hand-minute"></div><div class="hand-second seaclad-second" id="hand-second"></div><div class="center-pin seaclad-pin"></div></div></div><div class="glass-reflection"></div>`
        },
        accutron: {
            desc: 'Tuning Fork Module 360Hz<br>Spaceview Circuitry',
            isDigital: false, bph: 'smooth', hideMarkers: [],
            template: `<div class="watch-face accutron-face"><div class="accutron-pcb"><div class="pcb-trace trace-1"></div><div class="pcb-trace trace-2"></div><div class="accutron-coil coil-left"></div><div class="accutron-coil coil-right"></div><div class="accutron-component comp-1"></div><div class="accutron-component comp-2"></div><div class="tuning-fork"><div class="tf-tine tine-left"></div><div class="tf-tine tine-right"></div></div></div><div class="chapter-ring"><div class="watch-brand accutron-brand">IRONCLAD</div><div class="watch-model accutron-model">SPACEVIEW</div></div><div id="hour-markers"></div><div class="hands-container"><div class="hand-hour accutron-hour" id="hand-hour"></div><div class="hand-minute accutron-minute" id="hand-minute"></div><div class="hand-second accutron-second" id="hand-second"></div><div class="center-pin accutron-pin"></div></div><div class="glass-reflection accutron-glass"></div></div>`
        },
        digital: {
            desc: 'Illuminator Module<br>Resin Square Case',
            isDigital: true, hideMarkers: [],
            template: `<div class="w800-bezel"><div class="w800-brand">IRONCLAD</div><div class="w800-illuminator">ILLUMINATOR</div><div class="w800-wr">WATER 100M RESIST</div><div class="w800-lcd"><div class="lcd-header"><span id="lcd-year">2026</span><span id="lcd-date">10-25</span><span id="lcd-day">MON</span></div><div class="lcd-time-row"><span id="lcd-hour">10</span><span class="lcd-colon">:</span><span id="lcd-minute">58</span><span id="lcd-second">34</span></div></div><div class="glass-reflection digital-glass"></div></div>`
        },
        touchtron: {
            desc: 'Vintage LED Quartz 39mm<br>Touch Case to Display Time',
            isDigital: true,
            hideMarkers: [],
            template: `
                <div class="touchtron-brand">ORIENT</div>
                <div class="touchtron-screen">
                    <div class="touchtron-led" id="touchtron-display">88:88</div>
                </div>
                <div class="touchtron-model">TOUCHTRON</div>
                <div class="glass-reflection touchtron-glass"></div>
            `,
            onMount: function() {
                const watchCase = document.getElementById('watch-case');
                const timeDisplay = document.getElementById('touchtron-display');
                let timeoutId;
                let isLEDActive = false;

                // Capture the click on the watch case, not just the screen, to mimic the real watch behavior
                watchCase.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    
                    const now = new Date();
                    const hours = String(now.getHours()).padStart(2, '0');
                    const minutes = String(now.getMinutes()).padStart(2, '0');
                    
                    timeDisplay.textContent = `${hours}:${minutes}`;
                    timeDisplay.classList.add('active');
                    isLEDActive = true;

                    if (timeoutId) clearTimeout(timeoutId);

                    // Battery saving: auto-off after 2.5s, mimicking real LED watches
                    timeoutId = setTimeout(() => {
                        timeDisplay.classList.remove('active');
                        isLEDActive = false;
                    }, 2500);
                });

                // Touch support: same logic as mouse but with touch events. We use 'passive: true' to allow scrolling on mobile without delay.
                watchCase.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    const now = new Date();
                    const hours = String(now.getHours()).padStart(2, '0');
                    const minutes = String(now.getMinutes()).padStart(2, '0');
                    
                    timeDisplay.textContent = `${hours}:${minutes}`;
                    timeDisplay.classList.add('active');
                    isLEDActive = true;

                    if (timeoutId) clearTimeout(timeoutId);

                    timeoutId = setTimeout(() => {
                        timeDisplay.classList.remove('active');
                        isLEDActive = false;
                    }, 2500);
                }, { passive: true });
            }
        },
        hamilton: {
            desc: 'Swiss Field Auto 21600 BPH<br>Caliber H-10 (80h Power Reserve)',
            isDigital: false,
            bph: 21600, // Calibre H-10 
            hideMarkers: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 
            template: `
                <div class="watch-crown hamilton-crown"></div>
                <div class="hamilton-bezel"></div>
                
                <div class="watch-face hamilton-face">
                    <div id="hamilton-numerals"></div>
                    
                    <div class="watch-brand hamilton-brand">HAMILTON</div>
                    <div class="watch-specs hamilton-specs">KHAKI<br>AUTOMATIC</div>
                    
                    <div class="date-window hamilton-date"><span class="date-number" id="date-display">--</span></div>
                    
                    <div class="hands-container">
                        <div class="hand-hour hamilton-hour" id="hand-hour"></div>
                        <div class="hand-minute hamilton-minute" id="hand-minute"></div>
                        <div class="hand-second hamilton-second" id="hand-second"></div>
                        <div class="center-pin hamilton-pin"></div>
                    </div>
                </div>
                <div class="glass-reflection"></div>
            `,
            onMount: function() {
                const container = document.getElementById('hamilton-numerals');
                if (!container) return;
                container.innerHTML = '';
                
                // 1. Minutes Track (Ticks)
                for(let i = 0; i < 60; i++) {
                    const angle = i * 6;
                    const minDiv = document.createElement('div');
                    minDiv.className = (i % 5 === 0) ? 'khaki-min-tick major' : 'khaki-min-tick';
                    minDiv.style.transform = `rotate(${angle}deg)`;
                    container.appendChild(minDiv);
                }

                // 2. Military Numbers (1-12 Outer, 13-24 Inner)
                for (let i = 1; i <= 12; i++) {
                    if (i === 3) continue; 
                    const angle = i * 30;
                    
                    // Outer 1-12
                    const outerDiv = document.createElement('div');
                    outerDiv.className = 'khaki-num-outer';
                    outerDiv.style.transform = `rotate(${angle}deg)`;
                    outerDiv.innerHTML = `<span style="transform: rotate(-${angle}deg)">${i}</span>`;
                    container.appendChild(outerDiv);

                    // Inner 13-24 
                    const innerDiv = document.createElement('div');
                    innerDiv.className = 'khaki-num-inner';
                    innerDiv.style.transform = `rotate(${angle}deg)`;
                    // The 12 o'clock position shows 24
                    const militaryNum = (i === 12) ? 24 : i + 12;
                    // The 15 (3 o'clock position) is skipped in the loop above, but we still calculate its military number for consistency
                    innerDiv.innerHTML = `<span style="transform: rotate(-${angle}deg)">${militaryNum}</span>`;
                    container.appendChild(innerDiv);
                }
            }
        },
        databank: {
            desc: 'Calculator Watch Module<br>Resin Case with Keypad',
            isDigital: true, hideMarkers: [],
            template: `<div class="dbc-bezel"><div class="dbc-screen-area"><div class="dbc-brand">IRONCLAD <span class="dbc-sub">DATABANK</span></div><div class="dbc-lcd" id="dbc-lcd"><div id="dbc-time-mode"><div class="dbc-header"><span id="dbc-year">2026</span><span id="dbc-date">10-25</span><span id="dbc-day">MON</span></div><div class="dbc-time-row"><span id="dbc-hour">10</span><span class="dbc-colon">:</span><span id="dbc-minute">58</span><span id="dbc-second">34</span></div></div><div id="dbc-calc-mode" style="display: none;"><div class="dbc-calc-indicator">CALC</div><div class="dbc-calc-display" id="dbc-calc-display">0</div></div></div></div><div class="dbc-keypad"><button class="dbc-key" data-action="mode">MODE</button><button class="dbc-key" data-num="7">7</button><button class="dbc-key" data-num="8">8</button><button class="dbc-key" data-num="9">9</button><button class="dbc-key dbc-op" data-op="/">÷</button><button class="dbc-key" data-action="clear">C</button><button class="dbc-key" data-num="4">4</button><button class="dbc-key" data-num="5">5</button><button class="dbc-key" data-num="6">6</button><button class="dbc-key dbc-op" data-op="*">×</button><button class="dbc-key" data-num="0">0</button><button class="dbc-key" data-num="1">1</button><button class="dbc-key" data-num="2">2</button><button class="dbc-key" data-num="3">3</button><button class="dbc-key dbc-op" data-op="-">-</button><button class="dbc-key" data-num=".">.</button><button class="dbc-key dbc-eq" data-action="calculate">=</button><button class="dbc-key dbc-op" data-op="+">+</button></div><div class="glass-reflection dbc-glass"></div></div>`,
            onMount: function() {
                loadCalcState();
                const timeModeEl = document.getElementById('dbc-time-mode');
                const calcModeEl = document.getElementById('dbc-calc-mode');
                const calcDisplayEl = document.getElementById('dbc-calc-display');
                
                timeModeEl.style.display = calcState.isCalcMode ? 'none' : 'block';
                calcModeEl.style.display = calcState.isCalcMode ? 'block' : 'none';
                calcDisplayEl.textContent = calcState.display;
                
                const calculate = (n1, operator, n2) => {
                    const firstNum = parseFloat(n1);
                    const secondNum = parseFloat(n2);
                    if (operator === '+') return firstNum + secondNum;
                    if (operator === '-') return firstNum - secondNum;
                    if (operator === '*') return firstNum * secondNum;
                    if (operator === '/') return secondNum === 0 ? 'ERR' : firstNum / secondNum;
                    return secondNum;
                };

                document.querySelectorAll('.dbc-key').forEach(button => {
                    button.addEventListener('click', (e) => {
                        e.stopPropagation(); 
                        const val = e.target.dataset.num;
                        const action = e.target.dataset.action;
                        const op = e.target.dataset.op;

                        if (action === 'mode') {
                            calcState.isCalcMode = !calcState.isCalcMode;
                            timeModeEl.style.display = calcState.isCalcMode ? 'none' : 'block';
                            calcModeEl.style.display = calcState.isCalcMode ? 'block' : 'none';
                            saveCalcState();
                            return;
                        }

                        if (!calcState.isCalcMode) return;

                        if (val !== undefined) {
                            if (calcState.waitingForNewValue) {
                                calcState.display = val;
                                calcState.waitingForNewValue = false;
                            } else {
                                calcState.display = calcState.display === '0' ? val : calcState.display + val;
                            }
                        }

                        if (op !== undefined) {
                            const inputValue = parseFloat(calcState.display);
                            if (calcState.firstOperand === null && !isNaN(inputValue)) {
                                calcState.firstOperand = inputValue;
                            } else if (calcState.operator) {
                                const result = calculate(calcState.firstOperand, calcState.operator, inputValue);
                                calcState.display = String(result).substring(0, 8); 
                                calcState.firstOperand = result;
                            }
                            calcState.operator = op;
                            calcState.waitingForNewValue = true;
                        }

                        if (action === 'calculate') {
                            if (calcState.operator && !calcState.waitingForNewValue) {
                                const result = calculate(calcState.firstOperand, calcState.operator, parseFloat(calcState.display));
                                calcState.display = String(result).substring(0, 8);
                                calcState.firstOperand = null;
                                calcState.operator = null;
                                calcState.waitingForNewValue = true;
                            }
                        }

                        if (action === 'clear') {
                            calcState.display = '0';
                            calcState.firstOperand = null;
                            calcState.operator = null;
                            calcState.waitingForNewValue = false;
                        }

                        calcDisplayEl.textContent = calcState.display;
                        saveCalcState();
                    });
                });
            }
        }
    };

    function init() {
        const select = document.getElementById('watch-style-select');
        const savedMode = localStorage.getItem('ironclad_watch_mode');
        
        if (savedMode && WATCH_CATALOG[savedMode]) {
            select.value = savedMode;
        }

        requestLocation();

        select.addEventListener('change', (e) => {
            const newMode = e.target.value;
            localStorage.setItem('ironclad_watch_mode', newMode);
            renderWatch(newMode);
        });

        setupMaximizeFeature();
        renderWatch(select.value);
        requestRef = requestAnimationFrame(updateLoop);
    }

    function setupMaximizeFeature() {
        const maximizeBtn = document.getElementById('maximize-watch-btn');
        const closeModalBtn = document.getElementById('close-watch-modal');
        const modalOverlay = document.getElementById('watch-modal');
        const originalContainer = document.getElementById('original-watch-container');
        const maximizedContainer = document.getElementById('maximized-watch-container');
        const watchCase = document.getElementById('watch-case');

        function openModal() {
            isMaximized = true;
            maximizedContainer.appendChild(watchCase);
            modalOverlay.classList.add('active');
        }

        function closeModal() {
            isMaximized = false;
            modalOverlay.classList.remove('active');
            setTimeout(() => { originalContainer.appendChild(watchCase); }, 300);
        }

        maximizeBtn.addEventListener('click', openModal);
        closeModalBtn.addEventListener('click', closeModal);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isMaximized) closeModal(); });
    }

    function renderWatch(mode) {
        const watch = WATCH_CATALOG[mode];
        if (!watch) return; 

        currentMode = mode;
        document.getElementById('watch-case').className = `watch-case ${mode}`;
        document.getElementById('watch-description').innerHTML = watch.desc;
        document.getElementById('watch-case').innerHTML = watch.template;

        if (!watch.isDigital) {
            const hourMarkers = document.getElementById('hour-markers');
            if (hourMarkers) {
                const hidden = watch.hideMarkers || [];
                for (let i = 0; i < 12; i++) {
                    const marker = document.createElement('div');
                    marker.className = i % 3 === 0 ? 'hour-marker major' : 'hour-marker';
                    marker.style.transform = `translateX(-50%) rotate(${i * 30}deg)`;
                    if (hidden.includes(i)) marker.style.display = 'none';
                    hourMarkers.appendChild(marker);
                }
            }
        }
        if (typeof watch.onMount === 'function') watch.onMount();
        
        updateSunlightReflection(new Date(), true);
    }
    
    function updateLoop() {
        const now = new Date();
        const watch = WATCH_CATALOG[currentMode];
        if (!watch) { requestRef = requestAnimationFrame(updateLoop); return; }

        updateSunlightReflection(now);

        if (currentMode === 'casiotron') {
            const headerEl = document.getElementById('casio-header');
            const mainEl = document.getElementById('casio-main');
            const secEl = document.getElementById('casio-sec');
            const lcdEl = document.getElementById('casiotron-lcd');
            const pmEl = document.getElementById('casio-pm');
            const indRcvd = document.getElementById('casio-ind-1'); 

            // Ghost indicators in the DOM
            const indAlm = document.querySelector('.casio-indicators-row span:nth-child(4)'); // ALM
            const indSig = document.querySelector('.casio-indicators-row span:nth-child(5)'); // SIG (Hourly Chime)
            const indMute = document.getElementById('casio-ind-mute'); // MUTE 
            const indSnz = document.querySelector('.casio-indicators-row span:nth-child(3)'); // SNZ (Snooze) - not used IRL but TIMER

            if (!headerEl) return;

            // Illumination
            if (casiotronState.light) lcdEl.classList.add('illuminated');
            else lcdEl.classList.remove('illuminated');

            // Paint active indicators
            if (indAlm) indAlm.className = casiotronState.alm.active ? 'active' : '';
            if (indSig) indSig.className = casiotronState.sig ? 'active' : '';
            if (indMute) indMute.className = casiotronState.isMuted ? 'active' : '';
            // Enciende SNZ si el Timer está corriendo o pausado a la mitad
            if (indSnz) indSnz.className = (casiotronState.tmr.running || casiotronState.tmr.remaining < casiotronState.tmr.default) ? 'active' : '';

            // Blinking logic for adjustments
            const blink = casiotronState.isAdjusting && casiotronState.blinkFlag ? ' ' : '';

            // Format current time for top-right display in modes
            let currentHourShort = now.getHours();
            if (!casiotronState.is24h) {
                currentHourShort = currentHourShort % 12 || 12;
            }
            const timeString = `${currentHourShort}:${String(now.getMinutes()).padStart(2, '0')}`;

            if (casiotronState.mode === 0) {
                // MODE: TIME
                const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
                const isPM = now.getHours() >= 12;

                let displayHour = now.getHours();
                if (!casiotronState.is24h) {
                    displayHour = displayHour % 12 || 12; 
                    pmEl.textContent = 'P';
                    pmEl.style.visibility = isPM ? 'visible' : 'hidden';
                } else {
                    pmEl.textContent = '24H';
                    pmEl.style.visibility = 'visible';
                }

                headerEl.innerHTML = `<strong class="casiotron-day">${days[now.getDay()]}</strong> ${now.getMonth() + 1}.${String(now.getDate()).padStart(2, '0')}`;
                mainEl.textContent = `${String(displayHour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                secEl.textContent = String(now.getSeconds()).padStart(2, '0');
                indRcvd.className = 'active'; 
            }

            else if (casiotronState.mode === 1) {
                // MODE: WORLD TIME
                const city = worldCities[casiotronState.wtIndex];
                headerEl.innerHTML = `<strong class="casiotron-day">WT</strong> ${city.code}`;

                const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                const wtDate = new Date(utc + (3600000 * city.offset));

                let displayHour = wtDate.getHours();
                if (!casiotronState.is24h) {
                    pmEl.textContent = 'P';
                    pmEl.style.visibility = displayHour >= 12 ? 'visible' : 'hidden';
                    displayHour = displayHour % 12 || 12;
                } else {
                    pmEl.textContent = '24H';
                    pmEl.style.visibility = 'visible';
                }

                mainEl.textContent = `${String(displayHour).padStart(2, '0')}:${String(wtDate.getMinutes()).padStart(2, '0')}`;
                secEl.textContent = String(wtDate.getSeconds()).padStart(2, '0');
                indRcvd.className = '';
            }

            else if (casiotronState.mode === 2) {
                // MODE: STOPWATCH
                pmEl.style.visibility = 'hidden';
                indRcvd.className = '';
                
                // Show SPL if in split mode, else STW
                const modeLabel = casiotronState.stw.isSplit ? 'SPL' : 'STW';
                headerEl.innerHTML = `<strong class="casiotron-day">${modeLabel}</strong><strong class="strong-time">${timeString}</strong>`;
                
                let totalMs = 0;
                if (casiotronState.stw.isSplit) {
                    // Frozen display
                    totalMs = casiotronState.stw.splitTime;
                } else {
                    // Running display
                    totalMs = casiotronState.stw.elapsed;
                    if (casiotronState.stw.running) totalMs += now.getTime() - casiotronState.stw.start;
                }

                const ms = Math.floor((totalMs % 1000) / 10);
                const s = Math.floor((totalMs / 1000) % 60);
                const m = Math.floor((totalMs / 60000) % 60);
                mainEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                secEl.textContent = String(ms).padStart(2, '0');
            }

            else if (casiotronState.mode === 3) {
                // MODE: TIMER
                headerEl.innerHTML = `<strong class="casiotron-day">TMR</strong><strong class="strong-time">${timeString}</strong>`;
                pmEl.style.visibility = 'hidden';

                let remain = casiotronState.tmr.remaining;
                if (casiotronState.tmr.running) {
                    remain = casiotronState.tmr.end - now.getTime();
                    if (remain <= 0) {
                        remain = 0;
                        casiotronState.tmr.running = false;
                        casiotronState.tmr.remaining = casiotronState.tmr.default; 
                        casiotronState.tmr.isAlerting = true;
                        triggerAlarm(); 
                        saveCasiotronState(); 
                    }
                }
                const s = Math.floor((remain / 1000) % 60);
                const m = Math.floor((remain / 60000) % 60);

                if (casiotronState.isAdjusting && !casiotronState.blinkFlag) {
                    mainEl.textContent = `  :  `;
                } else {
                    mainEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                }

                secEl.textContent = "00";
                indRcvd.className = '';
            }

            else if (casiotronState.mode === 4) {
                // MODE: ALARM
                headerEl.innerHTML = `<strong class="casiotron-day">ALM</strong><strong class="strong-time">${timeString}</strong>`;
                pmEl.style.visibility = 'hidden';

                if (casiotronState.isAdjusting && !casiotronState.blinkFlag) {
                    mainEl.textContent = `  :00`;
                } else {
                    mainEl.textContent = `${String(casiotronState.alm.hours).padStart(2, '0')}:00`;
                }

                // Show ON/OFF for ALM state only (SIG state is shown by the SIG indicator above)
                secEl.textContent = casiotronState.alm.active ? "ON" : "OF";
                indRcvd.className = '';
            }

            // --- ALARM TRIGGER CODE ---
            if (casiotronState.alm.active && !casiotronState.alm.isAlerting &&
                now.getHours() === casiotronState.alm.hours &&
                now.getMinutes() === casiotronState.alm.minutes &&
                now.getSeconds() === 0) {
                casiotronState.alm.isAlerting = true;
                triggerAlarm();
            }

            // --- HOURLY CHIME TRIGGER CODE ---
            if (casiotronState.sig && now.getMinutes() === 0 && now.getSeconds() === 0) {
                // Ensures it only triggers once during the 00 second
                if (casiotronState.lastChimeHour !== now.getHours()) {
                    casiotronState.lastChimeHour = now.getHours();
                    playCasioBeep('alarm'); // Casio hourly chime is exactly a double-beep
                }
            } else if (now.getSeconds() !== 0) {
                // Reset the guard once the minute moves past 00:00
                casiotronState.lastChimeHour = -1;
            }

        } else if (watch.isDigital) {
            // --- NORMAL DIGITAL LOGIC (W800 / DATABANK) ---
            const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
            const prefix = currentMode === 'databank' ? 'dbc' : 'lcd';
            const yearEl = document.getElementById(`${prefix}-year`);
            if (yearEl) yearEl.textContent = now.getFullYear();
            const dateEl = document.getElementById(`${prefix}-date`);
            if (dateEl) dateEl.textContent = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const dayEl = document.getElementById(`${prefix}-day`);
            if (dayEl) dayEl.textContent = days[now.getDay()];
            const hourEl = document.getElementById(`${prefix}-hour`);
            if (hourEl) hourEl.textContent = String(now.getHours()).padStart(2, '0');
            const minEl = document.getElementById(`${prefix}-minute`);
            if (minEl) minEl.textContent = String(now.getMinutes()).padStart(2, '0');
            const secEl = document.getElementById(`${prefix}-second`);
            if (secEl) secEl.textContent = String(now.getSeconds()).padStart(2, '0');
        } else {
            const hours = now.getHours();
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();
            const milliseconds = now.getMilliseconds();
            
            const hourAngle = (hours % 12) * 30 + minutes * 0.5;
            const minuteAngle = minutes * 6 + seconds * 0.1;
            
            let secondAngle = 0;
            if (watch.bph === 'smooth') {
                secondAngle = (seconds * 6) + (milliseconds * 0.006);
            } else if (watch.bph) {
                const beatsPerSecond = watch.bph / 3600;
                const msPerBeat = 1000 / beatsPerSecond;
                const degreesPerBeat = 6 / beatsPerSecond;
                const totalMs = now.getTime();
                const beats = Math.floor(totalMs / msPerBeat);
                secondAngle = (beats * degreesPerBeat) % 360;
            } else {
                secondAngle = seconds * 6;
            }
            
            const handHour = document.getElementById('hand-hour');
            if(handHour) handHour.style.transform = `translateX(-50%) rotate(${hourAngle}deg)`;
            const handMin = document.getElementById('hand-minute');
            if(handMin) handMin.style.transform = `translateX(-50%) rotate(${minuteAngle}deg)`;
            const handSec = document.getElementById('hand-second');
            if(handSec) handSec.style.transform = `translateX(-50%) rotate(${secondAngle}deg)`;
            
            const dateDisplay = document.getElementById('date-display');
            if(dateDisplay) dateDisplay.textContent = now.getDate();
        }
        
        // document.getElementById('digital-time').textContent = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        requestRef = requestAnimationFrame(updateLoop);
    }

    function pause() {
        if (requestRef) {
            cancelAnimationFrame(requestRef);
            requestRef = null;
        }
    }

    function resume() {
        if (!requestRef) {
            requestRef = requestAnimationFrame(updateLoop);
        }
    }

    return { 
        init,
        pause,
        resume
    };
})();