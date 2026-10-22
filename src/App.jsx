import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { QrReader } from 'react-qr-reader';
import { Camera, CheckCircle2, Download, Pause, Play, PlusCircle } from 'lucide-react';

// HITSTER PRO / MP3 - Versión corregida
// npm install qrcode.react react-qr-reader lucide-react
// Cada QR contiene los datos de la canción y la URL HTTPS directa de su MP3.
// Requiere HTTPS para la cámara y los sensores del teléfono.

const FRAGMENT_SECONDS = 30;
const CAMERA_CONSTRAINTS = { facingMode: { ideal: 'environment' } };
const CAMERA_STYLE = { width: '100%', height: '100%', position: 'absolute', inset: 0 };
const VIDEO_CONTAINER_STYLE = { width: '100%', height: '100%', paddingTop: 0, position: 'relative', overflow: 'hidden' };
const VIDEO_STYLE = { width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 };

function validMp3Link(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function chooseRandomStart(duration, previous) {
  if (!Number.isFinite(duration) || duration <= FRAGMENT_SECONDS) return 0;
  // Si alcanza, evita los 10 primeros y 10 últimos segundos.
  const margin = duration >= 60 ? 10 : 0;
  const min = margin;
  const max = Math.max(min, Math.floor(duration - FRAGMENT_SECONDS - margin));
  if (max === min) return min;
  const minimumDifference = Math.min(15, Math.max(1, Math.floor((max - min) / 3)));
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const start = min + Math.floor(Math.random() * (max - min + 1));
    if (!Number.isFinite(previous) || Math.abs(previous - start) >= minimumDifference) return start;
  }
  return Math.abs(previous - min) > Math.abs(previous - max) ? min : max;
}

function safeFileName(value) {
  return String(value || 'cancion')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

// Pequeño WAV silencioso para intentar habilitar el elemento de audio desde el
// clic "Escanear tarjeta". En Safari es una ayuda, NO garantiza autoplay por giro.
function silentWavUrl() {
  const frames = 1600; // 0,2 segundos de silencio a 8 kHz / 8 bits / mono
  const bytes = new Uint8Array(44 + frames);
  const view = new DataView(bytes.buffer);
  const write = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + frames, true);
  write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  write(36, 'data'); view.setUint32(40, frames, true);
  bytes.fill(128, 44);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

export default function HitsterApp() {
  const [view, setView] = useState('menu');
  const [form, setForm] = useState({ year: '', artist: '', title: '', audioUrl: '' });
  const [qrSong, setQrSong] = useState(null);
  const [qrError, setQrError] = useState('');

  const [scannerInitialized, setScannerInitialized] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [motionMessage, setMotionMessage] = useState('');
  const [currentSong, setCurrentSong] = useState(null);
  const [isPrepared, setIsPrepared] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  const [audioError, setAudioError] = useState('');

  const audioRef = useRef(null);
  const qrCanvasRef = useRef(null);
  const viewRef = useRef(view);
  const songRef = useRef(null);
  const scannerBusyRef = useRef(false);
  const motionRequestedRef = useRef(false);
  const motionAllowedRef = useRef(false);
  const motionSamplesSeenRef = useRef(false);
  const downSinceRef = useRef(null);
  const autoTriggeredRef = useRef(false);
  const unlockAttemptedRef = useRef(false);
  const silenceUrlRef = useRef(null);
  const lastStartRef = useRef({});
  const lastRenderedUrlRef = useRef(null);

  // Control preciso del fragmento: NUNCA medir el final mientras se busca el inicio.
  const preparedRef = useRef(false);
  const segmentChosenRef = useRef(false);
  const seekPendingRef = useRef(false);
  const desiredStartRef = useRef(0);
  const segmentEndRef = useRef(0);
  const startedRef = useRef(false);
  const playPendingRef = useRef(false);
  const playingRef = useRef(false);
  const finishedRef = useRef(false);
  const revealedRef = useRef(false);
  const endIntervalRef = useRef(null);

  useEffect(() => { viewRef.current = view; }, [view]);

  // Volver a escanear la MISMA canción también debe elegir otro fragmento.
  // Como React no cambia el atributo src si la URL coincide, recargamos
  // expresamente en ese caso para recibir loadedmetadata otra vez.
  useEffect(() => {
    if (!currentSong || !audioRef.current) return;
    const repeated = lastRenderedUrlRef.current === currentSong.audioUrl;
    lastRenderedUrlRef.current = currentSong.audioUrl;
    if (repeated) audioRef.current.load();
  }, [currentSong]);

  // Impide que eventos tardíos del WAV silencioso o del MP3 anterior
  // preparen o terminen por accidente la canción nueva.
  const isActiveTrack = useCallback(() => {
    const song = songRef.current;
    const activeSrc = audioRef.current?.currentSrc;
    if (!song || !activeSrc) return false;
    try {
      return new URL(activeSrc, window.location.href).href === new URL(song.audioUrl, window.location.href).href;
    } catch {
      return false;
    }
  }, []);

  const clearEndTimer = useCallback(() => {
    if (endIntervalRef.current !== null) window.clearInterval(endIntervalRef.current);
    endIntervalRef.current = null;
  }, []);

  const pauseSong = useCallback(() => {
    clearEndTimer();
    if (audioRef.current) audioRef.current.pause();
    playingRef.current = false;
    playPendingRef.current = false;
    setIsPlaying(false);
  }, [clearEndTimer]);

  const finishFragment = useCallback(() => {
    if (!isActiveTrack() || !startedRef.current || seekPendingRef.current || finishedRef.current) return;
    const audio = audioRef.current;
    if (audio) audio.pause();
    clearEndTimer();
    playingRef.current = false;
    playPendingRef.current = false;
    finishedRef.current = true;
    setIsPlaying(false);
    setIsFinished(true);
  }, [clearEndTimer, isActiveTrack]);

  const checkEnd = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !isActiveTrack() || !startedRef.current || !playingRef.current || seekPendingRef.current) return;
    // Se mide desde el punto elegido, nunca desde 0 ni desde un seek incompleto.
    const elapsed = audio.currentTime - desiredStartRef.current;
    if (Number.isFinite(elapsed) && elapsed >= FRAGMENT_SECONDS - 0.07) finishFragment();
  }, [finishFragment, isActiveTrack]);

  const acknowledgeSeek = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !isActiveTrack() || !segmentChosenRef.current || preparedRef.current || audio.seeking) return;
    // Safari puede emitir timeupdate/loadeddata con la posición anterior: ignorarlas.
    if (Math.abs(audio.currentTime - desiredStartRef.current) > 1.5) return;
    seekPendingRef.current = false;
    preparedRef.current = true;
    setIsPrepared(true);
    setAudioError('');
  }, [isActiveTrack]);

  const prepareRandomSegment = useCallback(() => {
    const audio = audioRef.current;
    const song = songRef.current;
    if (!audio || !song || !isActiveTrack() || segmentChosenRef.current) return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const start = chooseRandomStart(duration, lastStartRef.current[song.audioUrl]);
    lastStartRef.current[song.audioUrl] = start;
    desiredStartRef.current = start;
    segmentEndRef.current = Math.min(duration, start + FRAGMENT_SECONDS);
    segmentChosenRef.current = true;
    preparedRef.current = false;
    seekPendingRef.current = true;
    setIsPrepared(false);

    try {
      audio.currentTime = start;
      // Si ya está en ese punto (p. ej. canción de menos de 30 segundos),
      // puede no dispararse seeked. canplay también confirmará el inicio.
      if (Math.abs(audio.currentTime - start) <= 1.5 && !audio.seeking) {
        acknowledgeSeek();
      }
    } catch {
      seekPendingRef.current = false;
      setAudioError('No fue posible buscar el punto aleatorio. Comprueba que R2 permita reproducir y avanzar el MP3.');
    }
  }, [acknowledgeSeek, isActiveTrack]);

  const playSong = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !isActiveTrack() || revealedRef.current || finishedRef.current || !preparedRef.current) return;
    if (playPendingRef.current || playingRef.current) return;
    playPendingRef.current = true;
    setAudioError('');
    // El .play() ocurre directamente en el evento del botón o del sensor.
    // Safari puede prohibirlo cuando procede del sensor (no es un toque).
    try {
      const promise = audio.play();
      if (promise && typeof promise.catch === 'function') {
        void promise.catch((error) => {
          playPendingRef.current = false;
          if (error?.name === 'AbortError') return;
          setAudioError(error?.name === 'NotAllowedError'
            ? 'Safari bloqueó el inicio por giro. Toca Play una vez para escuchar esta canción.'
            : 'No se pudo reproducir el MP3. Revisa el enlace y el formato del archivo.');
        });
      }
    } catch {
      playPendingRef.current = false;
      setAudioError('No se pudo iniciar el MP3. Prueba con el botón Play.');
    }
  }, [isActiveTrack]);

  const onAudioPlaying = () => {
    if (!isActiveTrack() || !preparedRef.current || seekPendingRef.current || finishedRef.current) return;
    startedRef.current = true;
    playPendingRef.current = false;
    playingRef.current = true;
    setIsPlaying(true);
    setAudioError('');
    clearEndTimer();
    endIntervalRef.current = window.setInterval(checkEnd, 200);
  };

  const loadSong = useCallback((song) => {
    pauseSong();
    songRef.current = song;
    preparedRef.current = false;
    segmentChosenRef.current = false;
    seekPendingRef.current = false;
    desiredStartRef.current = 0;
    segmentEndRef.current = 0;
    startedRef.current = false;
    finishedRef.current = false;
    revealedRef.current = false;
    autoTriggeredRef.current = false;
    downSinceRef.current = null;
    setCurrentSong(song);
    setIsPrepared(false);
    setIsPlaying(false);
    setIsFinished(false);
    setIsRevealed(false);
    setAudioError('');
    setView('player');
    viewRef.current = 'player';
  }, [pauseSong]);

  const handleScan = useCallback((result, error) => {
    if (viewRef.current !== 'scanner') return;
    if (error && ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) {
      setScannerError('Permite el uso de la cámara en Safari y abre la web mediante HTTPS.');
    } else if (error && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
      setScannerError('No se encontró una cámara disponible.');
    }
    if (!result?.text || scannerBusyRef.current) return;
    try {
      const parsed = JSON.parse(result.text);
      const audioUrl = String(parsed.audioUrl || parsed.mp3Url || '').trim();
      if (!validMp3Link(audioUrl)) {
        setScannerError(parsed.youtubeId
          ? 'Este QR utiliza YouTube. Crea un QR nuevo con el archivo MP3.'
          : 'El QR no contiene un enlace HTTPS válido a un MP3.');
        return;
      }
      scannerBusyRef.current = true;
      setScannerError('');
      loadSong({
        audioUrl,
        title: String(parsed.title || ''),
        artist: String(parsed.artist || ''),
        year: String(parsed.year || ''),
      });
    } catch {
      setScannerError('Este código no tiene el formato QR de Hitster Pro.');
    }
  }, [loadSong]);

  const authorizeMotionFromClick = () => {
    // iOS exige que se solicite DESDE un clic real, y puede pedir permisos
    // separados para DeviceMotionEvent y DeviceOrientationEvent.
    if (motionRequestedRef.current) return;
    motionRequestedRef.current = true;
    if (!('DeviceMotionEvent' in window) && !('DeviceOrientationEvent' in window)) {
      setMotionMessage('Este dispositivo no tiene sensores de giro. Usa Play.');
      return;
    }
    try {
      const requests = [];
      if (typeof window.DeviceMotionEvent?.requestPermission === 'function') {
        requests.push(window.DeviceMotionEvent.requestPermission());
      }
      if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
        requests.push(window.DeviceOrientationEvent.requestPermission());
      }
      if (requests.length === 0) {
        motionAllowedRef.current = true;
        setMotionAllowed(true);
        setMotionMessage('Detección del giro habilitada.');
      } else {
        void Promise.all(requests).then((answers) => {
          const granted = answers.some((answer) => answer === 'granted');
          motionAllowedRef.current = granted;
          setMotionAllowed(granted);
          setMotionMessage(granted
            ? 'Giro autorizado. Coloca el teléfono boca abajo para intentar reproducir.'
            : 'Safari no autorizó los sensores. Puedes usar Play.');
        }).catch(() => {
          setMotionMessage('No se pudo autorizar el giro. Puedes usar Play.');
        });
      }
    } catch {
      setMotionMessage('No se pudo solicitar el permiso del sensor. Puedes usar Play.');
    }
  };

  const warmUpAudioFromClick = () => {
    // Opcional: intentar desbloquear el elemento de audio mediante el toque en
    // "Escanear tarjeta". Evitamos interrupciones si Safari lo rechaza.
    if (unlockAttemptedRef.current || songRef.current || !audioRef.current) return;
    unlockAttemptedRef.current = true;
    try {
      const url = silentWavUrl();
      silenceUrlRef.current = url;
      audioRef.current.src = url;
      const promise = audioRef.current.play();
      if (promise && typeof promise.catch === 'function') void promise.catch(() => {});
    } catch {
      // Play seguirá disponible si el navegador no admite el desbloqueo.
    }
  };

  const openScanner = () => {
    pauseSong();
    if (!motionRequestedRef.current) authorizeMotionFromClick();
    warmUpAudioFromClick();
    scannerBusyRef.current = false;
    setScannerInitialized(true);
    setScannerError(window.isSecureContext ? '' : 'El escáner necesita HTTPS o localhost.');
    setView('scanner');
    viewRef.current = 'scanner';
  };

  // Detecta pantalla boca abajo con ACELERÓMETRO: z aprox. -9,8 m/s².
  // En dispositivos sin devicemotion, usa la orientación beta/gamma.
  useEffect(() => {
    if (!motionAllowed) return undefined;
    const acceptFaceDown = (isDown) => {
      if (viewRef.current !== 'player' || !songRef.current || revealedRef.current
        || finishedRef.current || autoTriggeredRef.current || playingRef.current) {
        downSinceRef.current = null;
        return;
      }
      if (!isDown) {
        downSinceRef.current = null;
        return;
      }
      const now = Date.now();
      if (downSinceRef.current === null) {
        downSinceRef.current = now;
      } else if (now - downSinceRef.current >= 250 && preparedRef.current) {
        autoTriggeredRef.current = true;
        downSinceRef.current = null;
        playSong();
      }
    };
    const onMotion = (event) => {
      const z = event.accelerationIncludingGravity?.z;
      if (!Number.isFinite(z)) return;
      motionSamplesSeenRef.current = true;
      acceptFaceDown(z < -6.2);
    };
    const onOrientation = (event) => {
      if (motionSamplesSeenRef.current) return;
      const beta = event.beta;
      const gamma = event.gamma;
      acceptFaceDown(Number.isFinite(beta) && Number.isFinite(gamma)
        && Math.abs(beta) > 145 && Math.abs(gamma) < 50);
    };
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrientation);
    return () => {
      window.removeEventListener('devicemotion', onMotion);
      window.removeEventListener('deviceorientation', onOrientation);
    };
  }, [motionAllowed, playSong]);

  useEffect(() => () => {
    clearEndTimer();
    if (silenceUrlRef.current) URL.revokeObjectURL(silenceUrlRef.current);
  }, [clearEndTimer]);

  const goMenu = () => { pauseSong(); setView('menu'); viewRef.current = 'menu'; };
  const reveal = () => {
    pauseSong();
    revealedRef.current = true;
    setIsRevealed(true);
  };

  const generateQR = (event) => {
    event.preventDefault();
    if (!validMp3Link(form.audioUrl)) {
      setQrError('Ingresa el enlace HTTPS directo al MP3 de Cloudflare R2.');
      setQrSong(null);
      return;
    }
    setQrError('');
    setQrSong({ year: form.year.trim(), artist: form.artist.trim(), title: form.title.trim(), audioUrl: form.audioUrl.trim() });
  };

  const downloadQR = () => {
    if (!qrSong || !qrCanvasRef.current) return;
    try {
      const png = qrCanvasRef.current.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = png;
      a.download = `QR_${safeFileName(qrSong.artist)}_${safeFileName(qrSong.title)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setQrError('No fue posible descargar el QR. Prueba otro navegador.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans flex flex-col items-center justify-center p-6 relative">
      {/* Audio HTML5 sin reproductor visual ni video. */}
      <audio
        ref={audioRef}
        src={currentSong?.audioUrl || undefined}
        preload="auto"
        playsInline
        onLoadedMetadata={prepareRandomSegment}
        onDurationChange={prepareRandomSegment}
        onSeeked={acknowledgeSeek}
        onCanPlay={acknowledgeSeek}
        onPlaying={onAudioPlaying}
        onPause={() => { clearEndTimer(); playingRef.current = false; setIsPlaying(false); }}
        onTimeUpdate={checkEnd}
        onEnded={() => {
          // Ignora fin del WAV silencioso y señales de fin anteriores al play real.
          if (!isActiveTrack() || !startedRef.current || seekPendingRef.current) return;
          finishFragment();
        }}
        onError={() => {
          if (!isActiveTrack()) return;
          pauseSong();
          preparedRef.current = false;
          setIsPrepared(false);
          setAudioError('El MP3 no se pudo cargar. Comprueba que el enlace de R2 abra el archivo directamente.');
        }}
      />

      <div className="w-full max-w-md text-center mb-8 z-10">
        <button onClick={goMenu} className="text-4xl font-black tracking-wider text-yellow-400">
          HITSTER <span className="text-white text-xl">PRO</span>
        </button>
        <p className="text-gray-400 text-sm mt-2">Tu juego musical familiar</p>
      </div>

      {view === 'menu' && (
        <div className="w-full max-w-md flex flex-col gap-4 z-10">
          <button onClick={openScanner} className="flex items-center justify-center gap-3 bg-green-500 hover:bg-green-600 p-6 rounded-2xl text-xl font-bold shadow-lg">
            <Camera size={28} /> Escanear tarjeta
          </button>
          <button onClick={() => setView('creator')} className="flex items-center justify-center gap-3 bg-gray-800 hover:bg-gray-700 p-6 rounded-2xl text-xl font-bold border border-gray-700">
            <PlusCircle size={28} /> Crear código QR MP3
          </button>
          {motionMessage && <p className="text-center text-gray-400 text-sm">{motionMessage}</p>}
        </div>
      )}

      {/* Mantener escáner montado reduce solicitudes repetidas de cámara. */}
      {scannerInitialized && (
        <div
          aria-hidden={view !== 'scanner'}
          className={view === 'scanner'
            ? 'w-full max-w-md flex flex-col items-center z-10'
            : 'fixed left-[-10000px] top-0 w-80 h-80 opacity-0 pointer-events-none overflow-hidden'}
        >
          {view === 'scanner' && <h2 className="text-2xl font-bold mb-4">Apunta al código QR</h2>}
          <div className="w-full aspect-square bg-gray-800 rounded-3xl overflow-hidden border-4 border-green-500 shadow-2xl relative">
            <QrReader
              videoId="hitster-camera-video"
              constraints={CAMERA_CONSTRAINTS}
              onResult={handleScan}
              scanDelay={300}
              containerStyle={CAMERA_STYLE}
              videoContainerStyle={VIDEO_CONTAINER_STYLE}
              videoStyle={VIDEO_STYLE}
            />
            {view === 'scanner' && <div className="pointer-events-none absolute inset-8 border-4 border-yellow-400 rounded-2xl z-20" />}
          </div>
          {view === 'scanner' && (
            <>
              {scannerError && <p role="alert" className="mt-4 p-3 rounded-xl bg-red-950 text-red-200 w-full">{scannerError}</p>}
              <button onClick={goMenu} className="mt-8 text-gray-300 underline">Volver al menú</button>
            </>
          )}
        </div>
      )}

      {view === 'creator' && (
        <div className="w-full max-w-md bg-gray-800 p-6 rounded-2xl shadow-xl z-10">
          <h2 className="text-2xl font-black text-yellow-400 text-center mb-3">Generar código QR MP3</h2>
          <p className="text-sm text-gray-300 text-center mb-6">Solo el QR en PNG, para que diseñes tus propias tarjetas.</p>
          <form onSubmit={generateQR} className="flex flex-col gap-4">
            {[
              ['year', 'Año', 'number', 'Ej. 1988'],
              ['artist', 'Artista', 'text', 'Ej. Soda Stereo'],
              ['title', 'Canción', 'text', 'Ej. En la ciudad de la furia'],
              ['audioUrl', 'Enlace público del MP3 en R2', 'url', 'https://...r2.dev/cancion.mp3'],
            ].map(([field, label, type, placeholder]) => (
              <label key={field} className="flex flex-col gap-1 text-sm font-semibold text-gray-200">
                {label}
                <input
                  required type={type} placeholder={placeholder} value={form[field]}
                  onChange={(event) => {
                    setForm((old) => ({ ...old, [field]: event.target.value }));
                    setQrSong(null);
                    setQrError('');
                  }}
                  className="p-3 bg-gray-700 rounded-lg text-white"
                />
              </label>
            ))}
            <button type="submit" className="bg-yellow-500 hover:bg-yellow-600 text-black font-black p-4 rounded-xl mt-2">GENERAR QR</button>
          </form>
          {qrError && <p role="alert" className="mt-4 p-3 bg-red-950 text-red-200 rounded-lg">{qrError}</p>}
          {qrSong && (
            <div className="mt-7 border-t border-gray-600 pt-6 flex flex-col items-center gap-4">
              <p className="text-green-400 font-bold">¡QR listo!</p>
              <div className="bg-white rounded-xl p-3">
                <QRCodeCanvas
                  ref={qrCanvasRef}
                  value={JSON.stringify(qrSong)}
                  size={700} level="M" marginSize={4}
                  bgColor="#FFFFFF" fgColor="#000000"
                  style={{ display: 'block', width: '240px', height: '240px' }}
                />
              </div>
              <p className="text-sm text-gray-300 text-center">{qrSong.artist} — {qrSong.title} ({qrSong.year})</p>
              <button type="button" onClick={downloadQR} className="w-full p-4 rounded-xl font-black bg-green-500 hover:bg-green-600 flex items-center justify-center gap-2">
                <Download size={22} /> DESCARGAR QR EN PNG
              </button>
              <button type="button" onClick={() => {
                if (!motionRequestedRef.current) authorizeMotionFromClick();
                warmUpAudioFromClick();
                loadSong(qrSong);
              }} className="w-full p-3 rounded-xl font-semibold border border-gray-500 hover:bg-gray-700">
                Probar esta canción
              </button>
              <button type="button" onClick={() => {
                setForm({ year: '', artist: '', title: '', audioUrl: '' });
                setQrSong(null);
              }} className="w-full p-3 rounded-xl border border-gray-500">Crear otro QR</button>
            </div>
          )}
          <button onClick={goMenu} className="w-full text-center mt-6 text-sm text-gray-300 underline">Volver al menú</button>
        </div>
      )}

      {view === 'player' && currentSong && (
        <div className="w-full max-w-md min-h-120 relative isolate overflow-hidden rounded-3xl bg-gray-950 border border-gray-700 shadow-2xl z-10">
          <div className="relative min-h-120 w-full flex flex-col items-center justify-center p-8">
            <h2 className="text-xl text-gray-300 font-semibold mb-6 text-center">
              {isRevealed ? 'Respuesta revelada' : 'Escucha y adivina la canción'}
            </h2>
            <div className={`relative flex items-center justify-center w-48 h-48 rounded-full bg-black border-4 border-gray-700 shadow-xl mb-6 ${isPlaying ? 'animate-spin' : ''}`}
              style={{ animationDuration: '3s' }}>
              <div className="absolute w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center">
                <div className="w-4 h-4 bg-gray-900 rounded-full" />
              </div>
            </div>
            <button
              disabled={!isPrepared || isRevealed || isFinished}
              onClick={() => { if (isPlaying) pauseSong(); else playSong(); }}
              aria-label={isPlaying ? 'Pausar canción' : 'Reproducir canción'}
              className="w-20 h-20 bg-green-500 hover:bg-green-600 disabled:opacity-40 rounded-full flex items-center justify-center shadow-lg mb-4"
            >
              {isPlaying ? <Pause size={36} /> : <Play size={36} className="ml-2" />}
            </button>
            {!isRevealed && (
              <p role={audioError ? 'alert' : undefined} className="text-sm text-gray-300 mb-4 text-center min-h-10">
                {audioError || (isFinished ? 'Los 30 segundos terminaron. Revela la respuesta o escanea otra tarjeta.'
                  : !isPrepared ? 'Buscando automáticamente un fragmento aleatorio del MP3...'
                    : isPlaying ? 'Reproduciendo 30 segundos aleatorios.'
                      : motionAllowed ? 'Pon el iPhone boca abajo; si Safari lo impide, presiona Play.'
                        : 'Presiona Play para escuchar la canción.')}
              </p>
            )}
            {isRevealed && (
              <div className="w-full text-center mb-6">
                <div className="text-6xl font-black text-yellow-400 mb-2">{currentSong.year}</div>
                <h3 className="text-2xl font-bold">{currentSong.title}</h3>
                <p className="text-lg text-gray-300">{currentSong.artist}</p>
              </div>
            )}
            {!isRevealed && (
              <button onClick={reveal} className="w-full py-4 bg-yellow-500 hover:bg-yellow-600 text-black font-black text-xl rounded-xl flex items-center justify-center gap-2">
                <CheckCircle2 size={24} /> REVELAR RESPUESTA
              </button>
            )}
            <button onClick={openScanner} className="mt-8 text-sm text-gray-300 underline">Escanear otra tarjeta</button>
          </div>
        </div>
      )}
    </div>
  );
}
