import { useState, useRef, useEffect } from 'react';
import ReactPlayer from 'react-player';
import { QRCodeSVG } from 'qrcode.react';
import { QrReader } from 'react-qr-reader';
import { Play, Pause, Camera, PlusCircle, CheckCircle2, Smartphone, Printer, ArrowLeft, FileSpreadsheet } from 'lucide-react';

const pastelColors = ['#BAE1FF', '#BAFFC9', '#FFFFBA', '#FFDFBA', '#FFB3BA', '#E8B9AB'];

export default function HitsterApp() {
  const [view, setView] = useState('menu'); 
  const [cards, setCards] = useState([]);
  
  const [formData, setFormData] = useState({ title: '', artist: '', year: '', youtubeId: '' });
  const [bulkData, setBulkData] = useState('');
  const [importMode, setImportMode] = useState('single');

  const [currentSong, setCurrentSong] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  
  const [isReady, setIsReady] = useState(false);
  const [gyroEnabled, setGyroEnabled] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [playerReady, setPlayerReady] = useState(false);
  const [showYouTubePlayer, setShowYouTubePlayer] = useState(false);
  
  const playerRef = useRef(null);
  const playTimerRef = useRef(null);
  const songAlreadyScannedRef = useRef(false);
  const didSeekRef = useRef(false);
  const playbackSourceRef = useRef(null);

  // Admite URL normal, enlace corto, Shorts o un ID directo de YouTube.
  const extractYouTubeID = (value) => {
    const input = String(value || '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    try {
      const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      const host = url.hostname.replace(/^www\./, '');
      let id = '';
      if (host === 'youtu.be') {
        id = url.pathname.split('/')[1];
      } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
        const segments = url.pathname.split('/').filter(Boolean);
        id = segments[0] === 'watch' ? url.searchParams.get('v') :
          ['shorts', 'embed', 'live'].includes(segments[0]) ? segments[1] : '';
      }
      return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : '';
    } catch {
      return '';
    }
  };

  const generateId = () => Date.now().toString() + Math.random().toString(36).substring(2, 11);

  const handleCreateCard = (e) => {
    e.preventDefault();
    const videoId = extractYouTubeID(formData.youtubeId);
    if (!videoId) {
      alert('El enlace de YouTube no es válido. Comprueba el link antes de crear la tarjeta.');
      return;
    }
    const newCard = { ...formData, youtubeId: videoId, id: generateId() };
    setCards(previous => [...previous, newCard]);
    setFormData({ title: '', artist: '', year: '', youtubeId: '' });
  };

  const handleBulkImport = () => {
    if (!bulkData.trim()) return;
    const lines = bulkData.split('\n');
    const newCards = [];
    let errors = 0;
    lines.forEach(line => {
      const cols = line.split('\t');
      if (cols.length >= 4) {
        const year = cols[0].trim();
        const artist = cols[1].trim();
        const title = cols[2].trim();
        const link = cols[3].trim();
        const videoId = extractYouTubeID(link);
        if (year && artist && title && videoId) {
          newCards.push({ title, artist, year, youtubeId: videoId, id: generateId() });
        } else errors++;
      } else if (line.trim() !== '') errors++;
    });
    setCards(previous => [...previous, ...newCards]);
    setBulkData('');
    alert(`¡Éxito! Se importaron ${newCards.length} tarjetas.\n${errors > 0 ? `Hubo ${errors} errores.` : ''}`);
  };

  // Los errores habituales de lectura de QR no son fallos de la cámara.
  // Aquí sí se muestran los errores de permiso, cámara no disponible o conexión insegura.
  const handleScan = (result, error) => {
    if (error) {
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) {
        setScannerError('Permite el acceso a la cámara en la configuración de este sitio y vuelve a cargar la página.');
      } else if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(error.name)) {
        setScannerError('No se encontró la cámara. Comprueba que esté conectada o prueba con otro navegador.');
      } else if (['NotReadableError', 'TrackStartError'].includes(error.name)) {
        setScannerError('La cámara está siendo utilizada por otra aplicación. Ciérrala y vuelve a intentarlo.');
      } else if (error.message?.includes('MediaDevices') || error.name === 'TypeError') {
        setScannerError('La cámara necesita una página HTTPS y los permisos del navegador.');
      }
    }
    if (!result?.text || songAlreadyScannedRef.current) return;
    try {
      const scannedData = JSON.parse(result.text);
      if (!scannedData.youtubeId || !/^[a-zA-Z0-9_-]{11}$/.test(scannedData.youtubeId)) {
        setScannerError('El QR no contiene un enlace de YouTube válido para este juego.');
        return;
      }
      songAlreadyScannedRef.current = true;
      didSeekRef.current = false;
      setScannerError('');
      setCurrentSong(scannedData);
      setIsRevealed(false);
      setIsPlaying(false);
      playbackSourceRef.current = null;
      setGyroEnabled(false);
      setIsReady(false);
      setPlayerReady(false);
      setPlayerError('');
      setShowYouTubePlayer(false);
      setView('player');
    } catch {
      setScannerError('El código escaneado no es una tarjeta de Hitster Pro.');
    }
  };

  // ReactPlayer 3 entrega la duración y expone currentTime (no seekTo).
  // Se elige aleatoriamente un segmento de hasta 30 segundos.
  const handleDurationChange = (reportedDuration) => {
    if (didSeekRef.current) return;
    const player = playerRef.current;
    const duration = typeof reportedDuration === 'number'
      ? reportedDuration : player?.duration;
    if (!player || !Number.isFinite(duration) || duration <= 0) return;
    didSeekRef.current = true;
    const maxStart = Math.max(0, Math.floor(duration - 30));
    if (maxStart > 0) {
      player.currentTime = Math.floor(Math.random() * (maxStart + 1));
    }
  };

  const startPlaying = (source = 'manual') => {
    if (isRevealed) return;
    playbackSourceRef.current = source;
    setPlayerError('');
    setIsPlaying(true);
  };

  const stopPlaying = () => {
    playbackSourceRef.current = null;
    setIsPlaying(false);
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = null;
  };

  const togglePlay = () => isPlaying ? stopPlaying() : startPlaying('manual');

  const handleActuallyPlaying = () => {
    // El contador comienza cuando YouTube inicia el audio, no mientras carga.
    setIsPlaying(true);
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = setTimeout(() => {
      playbackSourceRef.current = null;
      setIsPlaying(false);
    }, 30000);
  };

  useEffect(() => () => {
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
  }, []);

  const handleReadyClick = () => {
    setIsReady(true);
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(state => {
        setGyroEnabled(state === 'granted');
      }).catch(() => setGyroEnabled(false));
    } else if (typeof DeviceOrientationEvent !== 'undefined') {
      setGyroEnabled(true);
    }
    // No activar y detener el audio durante 500 ms: YouTube puede tardar en cargar.
    // En el siguiente paso la persona pulsa PLAY, lo que ayuda a desbloquear sonido móvil.
  };

  const openScanner = () => {
    songAlreadyScannedRef.current = false;
    setScannerError(
      typeof window !== 'undefined' && !window.isSecureContext
        ? 'Abre el juego desde un sitio HTTPS (o localhost). En HTTP la cámara puede estar bloqueada.'
        : ''
    );
    setView('scanner');
  };

  useEffect(() => {
    const handleOrientation = (event) => {
      if (!gyroEnabled || isRevealed || !isReady) return;
      const isFaceDown = (event.beta > 140 || event.beta < -140) && Math.abs(event.gamma) < 45;
      if (isFaceDown && !isPlaying) startPlaying('gyro');
      else if (!isFaceDown && isPlaying && playbackSourceRef.current === 'gyro') stopPlaying();
    };
    if (gyroEnabled) window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gyroEnabled, isPlaying, isRevealed, isReady]);

  // ==========================================
  // VISTA DE IMPRESIÓN (PDF)
  // ==========================================
  if (view === 'print') {
    return (
      <div className="bg-white text-black min-h-screen w-full font-sans">
        <div className="print:hidden bg-gray-900 text-white p-4 flex justify-between items-center shadow-md">
          <button onClick={() => setView('creator')} className="flex items-center gap-2 hover:text-yellow-400 font-bold transition-colors"><ArrowLeft size={24} /> Volver</button>
          <h2 className="text-xl font-bold">PDF ({cards.length} Tarjetas)</h2>
          <button onClick={() => window.print()} className="bg-yellow-500 hover:bg-yellow-600 text-black px-6 py-2 rounded-lg font-black flex items-center gap-2 shadow-lg"><Printer size={20} /> Guardar PDF</button>
        </div>
        <div className="p-8 print:p-0 w-full flex flex-col items-center">
          <div className="w-full max-w-[210mm] mb-12 print:mb-0">
            <h3 className="print:hidden text-2xl font-black mb-6 text-center border-b pb-2">Cara 1: Datos</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 65mm)', gap: '2mm', justifyContent: 'center' }}>
              {cards.map((card, idx) => (
                <div key={`data-${card.id}`} style={{ width: '65mm', height: '65mm', backgroundColor: pastelColors[idx % pastelColors.length], border: '1px dashed #999', boxSizing: 'border-box', padding: '5mm', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pageBreakInside: 'avoid' }}>
                  <span style={{ position: 'absolute', top: '3mm', left: '3mm', fontSize: '11px', fontWeight: '900', color: '#333' }}>#{idx + 1}</span>
                  <div style={{ fontSize: '32px', fontWeight: '900', color: '#000', lineHeight: '1', marginBottom: '4px', textAlign: 'center' }}>{card.year}</div>
                  <div style={{ fontSize: '12px', fontWeight: '900', color: '#000', textAlign: 'center', textTransform: 'uppercase', lineHeight: '1.2', marginBottom: '3px' }}>{card.artist}</div>
                  <div style={{ fontSize: '11px', color: '#222', textAlign: 'center', fontStyle: 'italic', lineHeight: '1.1' }}>{card.title}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ pageBreakBefore: 'always' }} className="print:block w-full hidden"></div>
          <hr className="print:hidden w-full max-w-[210mm] border-gray-400 border-2 my-12" />
          <div className="w-full max-w-[210mm]">
            <h3 className="print:hidden text-2xl font-black mb-6 text-center border-b pb-2">Cara 2: QRs</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 65mm)', gap: '2mm', justifyContent: 'center' }}>
              {cards.map((card, idx) => (
                <div key={`qr-${card.id}`} style={{ width: '65mm', height: '65mm', background: 'linear-gradient(135deg, #111111 0%, #2b2b2b 50%, #0a0a0a 100%)', border: '1px dashed #ccc', boxSizing: 'border-box', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', pageBreakInside: 'avoid' }}>
                  <div style={{ position: 'absolute', top: '2.5mm', bottom: '2.5mm', left: '2.5mm', right: '2.5mm', border: '2px solid #EAB308', borderRadius: '4px' }}></div>
                  <span style={{ position: 'absolute', top: '3.5mm', left: '4mm', fontSize: '11px', fontWeight: '900', color: '#EAB308' }}>#{idx + 1}</span>
                  <div style={{ background: '#fff', padding: '3mm', borderRadius: '4px', zIndex: 10 }}>
                    <QRCodeSVG value={JSON.stringify({ ...card })} size={120} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // VISTA PRINCIPAL
  // ==========================================
  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans flex flex-col items-center justify-center p-6 relative">
      

      <div className="w-full max-w-md text-center mb-8 z-10">
        <h1 className="text-4xl font-black tracking-wider text-yellow-400 drop-shadow-md cursor-pointer" onClick={() => { setView('menu'); stopPlaying(); }}>
          HITSTER <span className="text-white text-xl">PRO</span>
        </h1>
        <p className="text-gray-400 text-sm mt-2">Tu juego musical familiar</p>
      </div>

      {view === 'menu' && (
        <div className="w-full max-w-md flex flex-col gap-4 z-10">
          <button onClick={openScanner} className="flex items-center justify-center gap-3 bg-green-500 hover:bg-green-600 text-white p-6 rounded-2xl text-xl font-bold shadow-lg">
            <Camera size={28} /> Escanear Tarjeta
          </button>
          <button onClick={() => setView('creator')} className="flex items-center justify-center gap-3 bg-gray-800 hover:bg-gray-700 text-white p-6 rounded-2xl text-xl font-bold border border-gray-700">
            <PlusCircle size={28} /> Generar Tarjetas
          </button>
        </div>
      )}

      {/* CÁMARA: vídeo visible, con proporción correcta y errores claros */}
      {view === 'scanner' && (
        <div className="w-full max-w-md flex flex-col items-center z-10">
          <h2 className="text-2xl font-bold mb-4">Apunta al QR</h2>
          <p className="text-gray-300 text-sm mb-3">Deberías ver la imagen de la cámara dentro de este recuadro.</p>
          <div className="w-full aspect-square bg-gray-800 rounded-3xl overflow-hidden border-4 border-green-500 shadow-2xl relative">
            <QrReader
              key="hitster-scanner"
              videoId="hitster-camera-video"
              onResult={handleScan}
              constraints={{ facingMode: { ideal: 'environment' } }}
              scanDelay={300}
              containerStyle={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}
              videoContainerStyle={{ width: '100%', height: '100%', paddingTop: 0, position: 'relative', overflow: 'hidden' }}
              videoStyle={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 }}
            />
            <div className="pointer-events-none absolute inset-8 border-4 border-yellow-400 rounded-2xl z-20" />
          </div>
          {scannerError ? (
            <div role="alert" className="w-full bg-red-900/80 border border-red-400 rounded-xl p-4 text-sm mt-4">
              {scannerError}
            </div>
          ) : (
            <p className="text-gray-300 text-sm mt-4">Si el navegador solicita permiso, selecciona «Permitir cámara».</p>
          )}
          <button onClick={() => setView('menu')} className="mt-8 text-gray-400 hover:text-white underline font-medium">Volver al menú</button>
        </div>
      )}

      {view === 'creator' && (
        <div className="w-full max-w-md bg-gray-800 p-6 rounded-2xl shadow-xl z-10">
          <div className="flex gap-2 mb-6 border-b border-gray-700 pb-2">
            <button onClick={() => setImportMode('single')} className={`flex-1 py-2 font-bold rounded-t-lg transition-colors ${importMode === 'single' ? 'bg-gray-700 text-yellow-400' : 'text-gray-400 hover:text-white'}`}>Una por una</button>
            <button onClick={() => setImportMode('bulk')} className={`flex-1 py-2 font-bold rounded-t-lg transition-colors flex items-center justify-center gap-2 ${importMode === 'bulk' ? 'bg-gray-700 text-green-400' : 'text-gray-400 hover:text-white'}`}><FileSpreadsheet size={18}/> Desde Excel</button>
          </div>
          {importMode === 'single' ? (
            <form onSubmit={handleCreateCard} className="flex flex-col gap-4">
              <input required type="number" placeholder="Año Original" className="p-3 bg-gray-700 rounded-lg text-white" value={formData.year} onChange={e => setFormData({...formData, year: e.target.value})} />
              <input required type="text" placeholder="Artista" className="p-3 bg-gray-700 rounded-lg text-white" value={formData.artist} onChange={e => setFormData({...formData, artist: e.target.value})} />
              <input required type="text" placeholder="Nombre de la Canción" className="p-3 bg-gray-700 rounded-lg text-white" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} />
              <input required type="text" placeholder="Link de YouTube" className="p-3 bg-gray-700 rounded-lg text-white" value={formData.youtubeId} onChange={e => setFormData({...formData, youtubeId: e.target.value})} />
              <button type="submit" className="bg-yellow-500 hover:bg-yellow-600 text-black font-bold p-3 rounded-lg mt-2">Añadir a la lista (+1)</button>
            </form>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-400">1. Copia desde tu Excel:<br/><span className="text-white font-bold">AÑO | ARTISTA | CANCIÓN | LINK YOUTUBE</span><br/>2. Pega todo abajo:</p>
              <textarea className="w-full h-40 p-3 bg-gray-700 rounded-lg text-white text-sm" value={bulkData} onChange={e => setBulkData(e.target.value)} />
              <button onClick={handleBulkImport} className="bg-green-500 hover:bg-green-600 text-white font-bold p-3 rounded-lg mt-2 flex items-center justify-center gap-2"><FileSpreadsheet size={20} /> Importar Datos</button>
            </div>
          )}
          <div className="mt-8 border-t border-gray-700 pt-6">
            <button onClick={() => cards.length > 0 ? setView('print') : alert("Agrega canciones")} className={`w-full text-white font-bold p-4 rounded-xl flex items-center justify-center gap-2 shadow-lg transition-colors ${cards.length > 0 ? 'bg-blue-500 hover:bg-blue-600 animate-pulse' : 'bg-gray-600 opacity-50'}`}><Printer size={24} /> Generar PDF ({cards.length})</button>
            <button onClick={() => setView('menu')} className="w-full text-center mt-4 text-sm text-gray-400 hover:text-white underline">Volver al menú</button>
          </div>
        </div>
      )}

      {/* VISTA DEL REPRODUCTOR (Ya sin el botón bloqueado) */}
      {view === 'player' && currentSong && (
        <div className="w-full max-w-md flex flex-col items-center justify-center bg-gray-800 p-8 rounded-3xl shadow-2xl relative overflow-hidden min-h-[500px] z-10">
          {/* El reproductor sigue montado; normalmente permanece oculto para no revelar la respuesta.
              En caso de bloqueo de autoplay se puede mostrar y utilizar los controles de YouTube. */}
          <div
            className={showYouTubePlayer ? 'relative w-full flex justify-center mb-5 z-40' : 'absolute top-0 left-0 pointer-events-none z-0'}
            style={showYouTubePlayer ? {} : { width: 240, height: 200, opacity: 0.02 }}
          >
            <ReactPlayer
              ref={playerRef}
              src={`https://www.youtube.com/watch?v=${currentSong.youtubeId}`}
              playing={isPlaying}
              onReady={() => { setPlayerReady(true); setPlayerError(''); }}
              onDurationChange={handleDurationChange}
              onPlaying={handleActuallyPlaying}
              onPause={() => { if (playTimerRef.current) clearTimeout(playTimerRef.current); playTimerRef.current = null; setIsPlaying(false); }}
              onEnded={stopPlaying}
              onError={() => { setPlayerError('YouTube no pudo reproducir este video. Prueba con otra canción o muestra el reproductor.'); stopPlaying(); }}
              controls={true}
              width="240px"
              height="200px"
              playsInline={true}
              volume={1}
              muted={false}
              config={{ youtube: { playsinline: 1, rel: 0 } }}
            />
          </div>

          {!isReady && !isRevealed ? (
            <div className="absolute inset-0 z-50 bg-blue-600 flex flex-col items-center justify-center p-6 text-center animate-pulse">
                <Smartphone size={80} className="text-white mb-6 animate-bounce" />
                <h2 className="text-3xl font-black text-white mb-4 leading-tight">¡CANCION<br/>CARGADA!</h2>
                <p className="text-blue-100 text-lg mb-10 font-medium">Toca el botón, luego presiona PLAY para escuchar la canción. También puedes girar el teléfono.</p>
                
                <button 
                  onClick={handleReadyClick} 
                  className="w-full py-8 font-black text-3xl rounded-3xl transition-all bg-yellow-400 hover:bg-yellow-500 text-black shadow-[0_10px_0_rgb(202,138,4)] active:translate-y-2 active:shadow-[0_0px_0_rgb(202,138,4)]"
                >
                  ¡ESTOY LISTO!
                </button>

                <button onClick={() => { setView('menu'); stopPlaying(); }} className="mt-8 text-sm text-blue-200 hover:text-white underline">Cancelar</button>
            </div>
          ) : (
            <>
              <h2 className="text-xl text-gray-400 font-medium mb-6">{isRevealed ? "Respuesta Revelada" : "Gira el teléfono o presiona Play"}</h2>
              <div className={`relative flex items-center justify-center w-48 h-48 rounded-full bg-black border-4 border-gray-700 shadow-[0_0_30px_rgba(0,0,0,0.5)] mb-6 transition-transform duration-1000 ${isPlaying ? 'animate-spin' : ''}`} style={{ animationDuration: '3s' }}>
                <div className="absolute w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center"><div className="w-4 h-4 bg-gray-900 rounded-full"></div></div>
              </div>
              <div className="flex gap-4 mb-3">
                <button onClick={togglePlay} aria-label={isPlaying ? 'Pausar canción' : 'Reproducir canción'} className="w-20 h-20 bg-green-500 hover:bg-green-600 rounded-full flex items-center justify-center shadow-lg transform transition active:scale-95 z-40">
                  {isPlaying ? <Pause size={36} className="text-white" /> : <Play size={36} className="text-white ml-2" />}
                </button>
              </div>
              <p className="text-sm text-gray-300 mb-3 text-center">
                {playerError || (playerReady ? 'Presiona PLAY para escuchar hasta 30 segundos.' : 'Cargando la canción de YouTube...')}
              </p>
              <button onClick={() => setShowYouTubePlayer(v => !v)} className="text-xs text-blue-300 underline mb-6 z-40">
                {showYouTubePlayer ? 'Ocultar reproductor de YouTube' : '¿No se escucha? Mostrar reproductor de YouTube (puede revelar pistas)'}
              </button>
              <div className={`w-full text-center transition-all duration-500 ${isRevealed ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 hidden'}`}>
                <div className="text-6xl font-black text-yellow-400 mb-2 drop-shadow-lg">{currentSong.year}</div>
                <h3 className="text-2xl font-bold text-white">{currentSong.title}</h3>
                <p className="text-lg text-gray-300">{currentSong.artist}</p>
              </div>
              {!isRevealed && (
                <button onClick={() => { setIsRevealed(true); stopPlaying(); }} className="w-full py-4 bg-yellow-500 hover:bg-yellow-600 text-black font-black text-xl rounded-xl transition-colors flex items-center justify-center gap-2 z-40">
                  <CheckCircle2 size={24} /> REVELAR RESPUESTA
                </button>
              )}
              <button onClick={() => { setView('menu'); stopPlaying(); }} className="mt-8 text-sm text-gray-400 hover:text-white transition-colors z-40">Escanear otra tarjeta</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}