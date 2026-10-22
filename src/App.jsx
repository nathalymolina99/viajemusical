import { useState, useRef, useEffect, useCallback } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { QrReader } from 'react-qr-reader';
import { Play, Pause, Camera, PlusCircle, CheckCircle2, Download, RefreshCw } from 'lucide-react';

// HITSTER PRO - PRUEBA MP3 / Cloudflare R2
// Dependencias: npm install qrcode.react react-qr-reader lucide-react
// No se necesitan claves ni tokens de Cloudflare en el frontend.
// Usar un enlace HTTPS publico y directo a un MP3 que tengas permiso para reproducir.

const CAMERA_CONSTRAINTS = { facingMode: { ideal: 'environment' } };
const CAMERA_STYLE = { width: '100%', height: '100%', position: 'absolute', inset: 0 };
const VIDEO_CONTAINER_STYLE = { width: '100%', height: '100%', paddingTop: 0, position: 'relative', overflow: 'hidden' };
const VIDEO_STYLE = { display: 'block', width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 };
const SEGMENT_SECONDS = 30;

function isValidAudioUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function pickSegmentStart(duration, previousStart) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  // Si dura al menos 60 s, evitamos introduccion y final (10 s cada uno).
  const hasMargin = duration >= 60;
  const minimum = hasMargin ? 10 : 0;
  const maximum = Math.max(minimum, Math.floor(duration - SEGMENT_SECONDS - (hasMargin ? 10 : 0)));
  if (maximum <= minimum) return minimum;

  // Busca que el nuevo fragmento sea notablemente diferente al anterior.
  const distance = Math.min(15, Math.max(1, (maximum - minimum) / 3));
  for (let i = 0; i < 30; i += 1) {
    const candidate = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
    if (!Number.isFinite(previousStart) || Math.abs(candidate - previousStart) >= distance) {
      return candidate;
    }
  }
  return Math.abs(previousStart - minimum) > Math.abs(previousStart - maximum) ? minimum : maximum;
}

function safeFilename(text) {
  return String(text || 'cancion')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

export default function HitsterApp() {
  const [view, setView] = useState('menu');
  const [form, setForm] = useState({ title: '', artist: '', year: '', audioUrl: '' });
  const [qrSong, setQrSong] = useState(null);
  const [qrError, setQrError] = useState('');
  const qrCanvasRef = useRef(null);

  const [scannerInitialized, setScannerInitialized] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [motionMessage, setMotionMessage] = useState('');

  const [currentSong, setCurrentSong] = useState(null);
  const [audioVersion, setAudioVersion] = useState(0);
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  const [finished, setFinished] = useState(false);

  const audioRef = useRef(null);
  const viewRef = useRef(view);
  const currentSongRef = useRef(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const finishedRef = useRef(false);
  const revealedRef = useRef(false);
  const scannedRef = useRef(false);
  const flippedAlreadyRef = useRef(false);
  const lastStartByUrlRef = useRef({});
  const segmentEndRef = useRef(0);
  const stopTimerRef = useRef(null);

  useEffect(() => { viewRef.current = view; }, [view]);

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current) window.clearInterval(stopTimerRef.current);
    stopTimerRef.current = null;
  }, []);

  const pause = useCallback(() => {
    clearStopTimer();
    const audio = audioRef.current;
    if (audio) audio.pause();
    playingRef.current = false;
    setIsPlaying(false);
  }, [clearStopTimer]);

  const stopAtEnd = useCallback(() => {
    const audio = audioRef.current;
    if (audio && !audio.paused) audio.pause();
    clearStopTimer();
    playingRef.current = false;
    finishedRef.current = true;
    setFinished(true);
    setIsPlaying(false);
  }, [clearStopTimer]);

  const checkSegmentEnd = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !playingRef.current) return;
    if (audio.currentTime >= segmentEndRef.current - 0.08) stopAtEnd();
  }, [stopAtEnd]);

  const selectSegment = useCallback(() => {
    const audio = audioRef.current;
    const song = currentSongRef.current;
    if (!audio || !song || !Number.isFinite(audio.duration) || audio.duration <= 0) return false;
    const previous = lastStartByUrlRef.current[song.audioUrl];
    const start = pickSegmentStart(audio.duration, previous);
    lastStartByUrlRef.current[song.audioUrl] = start;
    segmentEndRef.current = Math.min(audio.duration, start + SEGMENT_SECONDS);
    audio.currentTime = start;
    readyRef.current = true;
    finishedRef.current = false;
    setFinished(false);
    setAudioReady(true);
    return true;
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentSongRef.current || revealedRef.current) return;
    if (!readyRef.current) {
      setAudioError('Esperando a que cargue el MP3. Si tarda, revisa el enlace.');
      return;
    }
    if (finishedRef.current) selectSegment();
    setAudioError('');
    try {
      // Safari solo permite la reproduccion por giro si su politica de audio lo autoriza.
      await audio.play();
    } catch (error) {
      playingRef.current = false;
      setIsPlaying(false);
      setAudioError(error?.name === 'NotAllowedError'
        ? 'Safari bloqueó el inicio por giro. Presiona Play para escuchar la canción.'
        : 'No se pudo iniciar el audio. Verifica que el enlace abra un MP3 reproducible.');
    }
  }, [selectSegment]);

  const handlePlaying = () => {
    playingRef.current = true;
    setIsPlaying(true);
    setAudioError('');
    clearStopTimer();
    // El evento timeupdate es la referencia principal. Este control ayuda en primer plano.
    stopTimerRef.current = window.setInterval(checkSegmentEnd, 250);
  };

  const onNewAudio = () => {
    readyRef.current = false;
    playingRef.current = false;
    finishedRef.current = false;
    clearStopTimer();
    setAudioReady(false);
    setIsPlaying(false);
    setFinished(false);
    setAudioError('');
  };

  const loadSong = useCallback((song) => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    playingRef.current = false;
    readyRef.current = false;
    finishedRef.current = false;
    revealedRef.current = false;
    flippedAlreadyRef.current = false;
    currentSongRef.current = song;
    // Fuerza cargar de nuevo incluso si escaneamos dos veces el mismo MP3.
    setAudioVersion((version) => version + 1);
    setCurrentSong(song);
    setIsPlaying(false);
    setFinished(false);
    setIsRevealed(false);
    setAudioReady(false);
    setAudioError('');
    setView('player');
    viewRef.current = 'player';
  }, []);

  const handleScan = useCallback((result, error) => {
    if (viewRef.current !== 'scanner') return;
    if (error) {
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) {
        setScannerError('Autoriza el uso de la cámara en Safari. Necesitas abrir el sitio mediante HTTPS.');
      } else if (['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
        setScannerError('No se encontró una cámara disponible.');
      } else if (error.name === 'NotReadableError') {
        setScannerError('La cámara está ocupada por otra aplicación.');
      }
    }
    if (!result?.text || scannedRef.current) return;
    try {
      const parsed = JSON.parse(result.text);
      const audioUrl = String(parsed.audioUrl || parsed.mp3Url || '').trim();
      if (!isValidAudioUrl(audioUrl)) {
        setScannerError(parsed.youtubeId
          ? 'Este es un QR antiguo de YouTube. Para usar MP3, crea uno nuevo con el enlace del audio.'
          : 'El QR no contiene un enlace HTTPS a un archivo de audio.');
        return;
      }
      scannedRef.current = true;
      setScannerError('');
      loadSong({
        audioUrl,
        title: String(parsed.title || ''),
        artist: String(parsed.artist || ''),
        year: String(parsed.year || ''),
      });
    } catch {
      setScannerError('No es un QR válido de Hitster Pro.');
    }
  }, [loadSong]);

  // En iOS el permiso del sensor debe pedirse desde un toque real del usuario.
  const requestMotionPermission = () => {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      setMotionMessage('Este dispositivo no dispone de orientación. Puedes usar Play.');
      return;
    }
    try {
      const Motion = window.DeviceOrientationEvent;
      if (typeof Motion.requestPermission === 'function') {
        // La llamada ocurre directamente dentro del click, sin await previo.
        Motion.requestPermission().then((decision) => {
          if (decision === 'granted') {
            setMotionEnabled(true);
            setMotionMessage('Giro activado.');
          } else {
            setMotionEnabled(false);
            setMotionMessage('No se autorizó el sensor. Puedes reproducir con Play.');
          }
        }).catch(() => {
          setMotionEnabled(false);
          setMotionMessage('No fue posible activar el sensor. Puedes reproducir con Play.');
        });
      } else {
        setMotionEnabled(true);
        setMotionMessage('Giro activado si el dispositivo admite el sensor.');
      }
    } catch {
      setMotionMessage('No se pudo solicitar permiso para el giro.');
    }
  };

  const openScanner = () => {
    pause();
    if (!motionEnabled) requestMotionPermission();
    scannedRef.current = false;
    setScannerInitialized(true);
    setScannerError(typeof window !== 'undefined' && !window.isSecureContext
      ? 'Para abrir la cámara, utiliza HTTPS o localhost.' : '');
    setView('scanner');
  };

  useEffect(() => {
    if (!motionEnabled) return undefined;
    const onOrientation = (event) => {
      if (viewRef.current !== 'player' || revealedRef.current || !readyRef.current) return;
      // Beta cercano a +/-180°, gamma cercano a 0°: pantalla hacia abajo.
      const down = Number.isFinite(event.beta) && Number.isFinite(event.gamma)
        && Math.abs(event.beta) >= 145 && Math.abs(event.gamma) <= 50;
      // Un giro inicia una vez. Volver a poner la pantalla hacia arriba NO pausa.
      if (down && !flippedAlreadyRef.current && !playingRef.current) {
        flippedAlreadyRef.current = true;
        void play();
      }
    };
    window.addEventListener('deviceorientation', onOrientation);
    return () => window.removeEventListener('deviceorientation', onOrientation);
  }, [motionEnabled, play]);

  useEffect(() => () => clearStopTimer(), [clearStopTimer]);

  const returnToMenu = () => {
    pause();
    setView('menu');
  };

  const generateQR = (event) => {
    event.preventDefault();
    if (!isValidAudioUrl(form.audioUrl)) {
      setQrError('Pega un enlace directo HTTPS al archivo MP3, no un enlace de compartir de Google Drive.');
      setQrSong(null);
      return;
    }
    setQrError('');
    setQrSong({
      year: form.year.trim(),
      artist: form.artist.trim(),
      title: form.title.trim(),
      audioUrl: form.audioUrl.trim(),
    });
  };

  const downloadQR = () => {
    if (!qrSong || !qrCanvasRef.current) return;
    try {
      const url = qrCanvasRef.current.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = `QR_${safeFilename(qrSong.artist)}_${safeFilename(qrSong.title)}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setQrError('No se pudo descargar el PNG. Intenta desde otro navegador.');
    }
  };

  const testQR = () => {
    if (!qrSong) return;
    if (!motionEnabled) requestMotionPermission();
    loadSong(qrSong);
  };

  const reveal = () => {
    pause();
    revealedRef.current = true;
    setIsRevealed(true);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans flex flex-col items-center justify-center p-6 relative">
      {/* Un solo <audio>, sin video ni reproductor visible de YouTube. */}
      <audio
        key={audioVersion}
        ref={audioRef}
        src={currentSong?.audioUrl || undefined}
        preload="metadata"
        playsInline
        onLoadStart={onNewAudio}
        onLoadedMetadata={() => {
          if (!selectSegment()) setAudioError('No se pudo obtener la duración del MP3.');
        }}
        onPlaying={handlePlaying}
        onPause={() => { clearStopTimer(); playingRef.current = false; setIsPlaying(false); }}
        onTimeUpdate={checkSegmentEnd}
        onEnded={stopAtEnd}
        onError={() => {
          pause();
          setAudioReady(false);
          readyRef.current = false;
          setAudioError('No se pudo cargar el MP3. Verifica que la URL sea pública y el archivo sea audio/mpeg.');
        }}
      />

      <div className="w-full max-w-md text-center mb-8 z-10">
        <button onClick={returnToMenu} className="text-4xl font-black tracking-wider text-yellow-400">
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
          <p className="text-center text-gray-400 text-sm">
            {motionMessage || 'Al tocar Escanear, Safari puede pedir permiso para la cámara y el sensor.'}
          </p>
        </div>
      )}

      {/* El lector permanece montado tras abrirlo una vez: se evitan nuevos pedidos
          de cámara por volver del reproductor al escáner. Safari gestiona el permiso. */}
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
              <button onClick={returnToMenu} className="mt-8 text-gray-300 underline">Volver al menú</button>
            </>
          )}
        </div>
      )}

      {view === 'creator' && (
        <div className="w-full max-w-md bg-gray-800 p-6 rounded-2xl shadow-xl z-10">
          <h2 className="text-2xl font-black text-yellow-400 text-center mb-3">Generar código QR MP3</h2>
          <p className="text-sm text-gray-300 text-center mb-6">
            Descarga solo el código QR en PNG; diseña las tarjetas a tu gusto.
          </p>
          <form onSubmit={generateQR} className="flex flex-col gap-4">
            {[
              ['year', 'Año de lanzamiento', 'number', 'Ej. 1998'],
              ['artist', 'Artista', 'text', 'Ej. Shakira'],
              ['title', 'Nombre de la canción', 'text', 'Ej. Ciega, sordomuda'],
              ['audioUrl', 'Enlace directo del MP3 en Cloudflare R2', 'url', 'https://...r2.dev/cancion.mp3'],
            ].map(([key, label, type, placeholder]) => (
              <label key={key} className="flex flex-col gap-1 text-sm font-semibold text-gray-200">
                {label}
                <input
                  type={type}
                  required
                  placeholder={placeholder}
                  value={form[key]}
                  onChange={(event) => {
                    setForm((previous) => ({ ...previous, [key]: event.target.value }));
                    setQrSong(null);
                    setQrError('');
                  }}
                  className="p-3 bg-gray-700 rounded-lg text-white"
                />
              </label>
            ))}
            <button type="submit" className="bg-yellow-500 hover:bg-yellow-600 text-black font-black p-4 rounded-xl mt-2">
              GENERAR QR
            </button>
          </form>
          {qrError && <p role="alert" className="mt-4 p-3 bg-red-950 text-red-200 rounded-lg">{qrError}</p>}
          {qrSong && (
            <div className="mt-7 border-t border-gray-600 pt-6 flex flex-col items-center gap-4">
              <p className="text-green-400 font-bold">¡QR listo!</p>
              <div className="bg-white rounded-xl p-3">
                <QRCodeCanvas
                  ref={qrCanvasRef}
                  value={JSON.stringify(qrSong)}
                  size={700}
                  level="M"
                  marginSize={4}
                  bgColor="#FFFFFF"
                  fgColor="#000000"
                  style={{ display: 'block', width: '240px', height: '240px' }}
                />
              </div>
              <p className="text-sm text-gray-300 text-center">{qrSong.artist} — {qrSong.title} ({qrSong.year})</p>
              <button type="button" onClick={downloadQR} className="w-full p-4 rounded-xl font-black bg-green-500 hover:bg-green-600 flex items-center justify-center gap-2">
                <Download size={22} /> DESCARGAR QR EN PNG
              </button>
              <button type="button" onClick={testQR} className="w-full p-3 rounded-xl font-semibold border border-gray-500 hover:bg-gray-700">
                Probar esta canción sin escanear
              </button>
              <button type="button" onClick={() => {
                setForm({ title: '', artist: '', year: '', audioUrl: '' });
                setQrSong(null);
              }} className="w-full p-3 rounded-xl border border-gray-500">Crear otro QR</button>
            </div>
          )}
          <button onClick={returnToMenu} className="w-full text-center mt-6 text-sm text-gray-300 underline">Volver al menú</button>
        </div>
      )}

      {view === 'player' && currentSong && (
        <div className="w-full max-w-md min-h-120 relative isolate overflow-hidden rounded-3xl bg-gray-950 border border-gray-700 shadow-2xl z-10">
          <div className="relative min-h-120 w-full flex flex-col items-center justify-center p-8">
            <h2 className="text-xl text-gray-300 font-semibold mb-6 text-center">
              {isRevealed ? 'Respuesta revelada' : 'Escucha y adivina la canción'}
            </h2>
            <div
              className={`relative flex items-center justify-center w-48 h-48 rounded-full bg-black border-4 border-gray-700 shadow-xl mb-6 ${isPlaying ? 'animate-spin' : ''}`}
              style={{ animationDuration: '3s' }}
            >
              <div className="absolute w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center">
                <div className="w-4 h-4 bg-gray-900 rounded-full" />
              </div>
            </div>
            <button
              disabled={!audioReady || isRevealed}
              onClick={() => { if (isPlaying) pause(); else void play(); }}
              aria-label={isPlaying ? 'Pausar canción' : 'Reproducir canción'}
              className="w-20 h-20 bg-green-500 hover:bg-green-600 disabled:opacity-40 rounded-full flex items-center justify-center shadow-lg mb-4"
            >
              {isPlaying ? <Pause size={36} /> : <Play size={36} className="ml-2" />}
            </button>
            {!isRevealed && (
              <p role={audioError ? 'alert' : undefined} className="text-sm text-gray-300 mb-4 text-center min-h-10">
                {audioError || (finished ? 'Terminó el fragmento. Pulsa Play para escuchar otro.' :
                  !audioReady ? 'Cargando MP3...' :
                    isPlaying ? 'Sonando: 30 segundos aleatorios.' :
                      motionEnabled ? 'Pon el celular boca abajo o presiona Play.' :
                        'Presiona Play. Para usar el giro, activa el permiso del sensor.')}
              </p>
            )}
            {!isRevealed && (
              <button onClick={() => { pause(); selectSegment(); void play(); }}
                disabled={!audioReady}
                className="mb-5 inline-flex items-center gap-2 text-sm text-gray-300 underline disabled:opacity-40">
                <RefreshCw size={16} /> Otro fragmento aleatorio
              </button>
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
