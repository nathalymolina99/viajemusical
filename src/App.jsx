import { useState, useRef, useEffect, useCallback } from 'react';
import { readSheet } from 'read-excel-file/browser';
import QRCode from 'qrcode';
import JSZip from 'jszip';
import ReactPlayer from 'react-player';
import { QRCodeCanvas } from 'qrcode.react';
import { QrReader } from 'react-qr-reader';
import { Play, Pause, Camera, PlusCircle, CheckCircle2, Download } from 'lucide-react';

// Mantener las opciones estables evita reiniciar el lector en cada cambio de pantalla.
const CAMERA_CONSTRAINTS = { facingMode: { ideal: 'environment' } };
const CAMERA_CONTAINER_STYLE = { width: '100%', height: '100%', position: 'absolute', inset: 0 };
const CAMERA_VIDEO_CONTAINER_STYLE = { width: '100%', height: '100%', paddingTop: 0, position: 'relative', overflow: 'hidden' };
const CAMERA_VIDEO_STYLE = { display: 'block', width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 };


// Importación Excel y generación de QR sin servicios externos ni backend.
function normalizarEncabezado(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buscarColumna(headers, alternatives) {
  return headers.findIndex((h) => alternatives.includes(normalizarEncabezado(h)));
}

function textoCelda(value) {
  return String(value ?? '').trim();
}

function nombreQRSeguro(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 42) || 'sin_nombre';
}

export default function HitsterApp() {
  const [view, setView] = useState('menu'); 
  const [formData, setFormData] = useState({ title: '', artist: '', year: '', youtubeId: '' });
  // Se guarda una sola canción generada; no se fabrican tarjetas ni PDFs.
  const [qrSong, setQrSong] = useState(null);
  const [qrError, setQrError] = useState('');
  // Importación masiva: no altera el escáner ni el reproductor.
  const [creatorMode, setCreatorMode] = useState('single');
  const [bulkSongs, setBulkSongs] = useState([]);
  const [bulkWarnings, setBulkWarnings] = useState([]);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkPaste, setBulkPaste] = useState('');

  const qrCanvasRef = useRef(null);

  const [currentSong, setCurrentSong] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);
  
  // El lector se monta solo la primera vez, y no se desmonta entre tarjetas.
  const [scannerInitialized, setScannerInitialized] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [playerReady, setPlayerReady] = useState(false);
  
  const playerRef = useRef(null);
  const playTimerRef = useRef(null);
  const songAlreadyScannedRef = useRef(false);
  const didSeekRef = useRef(false);
  const viewRef = useRef(view);

  // Sincronizar el ref después del render (react-hooks/refs).
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

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


  // Convierte una tabla de Excel (.xlsx o pegada) en canciones para nuestros QR.
  // Un mismo formato de QR se utiliza al crear individualmente o en masa.
  const parseBulkRows = (rows) => {
    if (!rows?.length) throw new Error('No hay canciones para importar.');
    if (rows.length > 2001) throw new Error('Puedes importar hasta 2.000 canciones por vez.');

    const first = rows[0] || [];
    let idxYear = buscarColumna(first, ['ano', 'anio', 'year', 'anolanzamiento', 'aniolanzamiento']);
    let idxArtist = buscarColumna(first, ['artista', 'artist', 'cantante', 'interprete']);
    let idxTitle = buscarColumna(first, ['cancion', 'canciontitulo', 'tema', 'title', 'titulo', 'nombrecancion', 'nombredelacancion']);
    let idxMedia = buscarColumna(first, ['enlaceyoutube', 'linkyoutube', 'youtube', 'youtubeid', 'linkdeyoutube', 'urlyoutube', 'enlacedeyoutube', 'link', 'enlace']);
    const hasHeader = [idxYear, idxArtist, idxTitle, idxMedia].every((index) => index >= 0);
    if (!hasHeader) {
      // Al pegar desde Excel se aceptan también filas SIN encabezado en este orden.
      // Si hay encabezados parciales, avisamos en vez de tratarlos como una canción.
      const partial = [idxYear, idxArtist, idxTitle, idxMedia].some((index) => index >= 0);
      if (partial) throw new Error('Encabezados incompletos: usa Año, Artista, Canción, Enlace YouTube.');
      [idxYear, idxArtist, idxTitle, idxMedia] = [0, 1, 2, 3];
    }
    const list = [];
    const warnings = [];
    const startRow = hasHeader ? 1 : 0;
    for (let i = startRow; i < rows.length; i += 1) {
      const row = rows[i] || [];
      if (row.every((cell) => !textoCelda(cell))) continue;
      const year = textoCelda(row[idxYear]);
      const artist = textoCelda(row[idxArtist]);
      const title = textoCelda(row[idxTitle]);
      const media = textoCelda(row[idxMedia]);
      if (!/^\d{4}$/.test(year) || !artist || !title || !media) {
        warnings.push(`Fila ${i + 1}: revisa año (4 dígitos) y datos obligatorios.`);
        continue;
      }
      const youtubeId = extractYouTubeID(media);
      if (!youtubeId) {
        warnings.push(`Fila ${i + 1}: enlace de YouTube no válido.`);
        continue;
      }
      list.push({ year, artist, title, youtubeId });
    }
    setBulkSongs(list);
    setBulkWarnings(warnings);
    setBulkProgress(0);
    setBulkStatus(list.length
      ? `¡${list.length} canciones listas para descargar! ${warnings.length ? `${warnings.length} fila(s) omitida(s).` : 'Sin errores.'}`
      : 'No hay canciones válidas. Revisa las columnas y los enlaces.');
  };

  // Cargar archivo .xlsx real.
  const importBulkExcel = async (file) => {
    if (!file) return;
    setBulkSongs([]);
    setBulkWarnings([]);
    setBulkStatus('Leyendo el archivo de Excel...');
    setBulkFileName(file.name);
    setBulkProgress(0);
    try {
      const rows = await readSheet(file);
      parseBulkRows(rows);
    } catch (error) {
      setBulkStatus(error?.message || 'No se pudo leer el Excel. Debe ser .xlsx.');
    }
  };

  // Pegar celdas copiadas desde Excel: las columnas llegan separadas por tabulaciones.
  const importBulkPaste = () => {
    setBulkSongs([]);
    setBulkWarnings([]);
    setBulkFileName('Datos copiados y pegados desde Excel');
    setBulkProgress(0);
    try {
      const input = bulkPaste.trim();
      if (!input) throw new Error('Copia tus filas de Excel y pégalas en el cuadro.');
      const rows = input.split(/\r?\n/).map((line) => line.replace(/\r$/, '').split('\t').map((cell) => cell.trim()));
      parseBulkRows(rows);
    } catch (error) {
      setBulkStatus(error?.message || 'No se pudo leer el contenido pegado.');
    }
  };

  // Crea TODOS los códigos en PNG y descarga un solo ZIP (evita 500 descargas).
  const downloadBulkQrs = async () => {
    if (!bulkSongs.length || bulkBusy) return;
    setBulkBusy(true);
    setBulkProgress(0);
    setBulkStatus('Generando imágenes QR...');
    try {
      const zip = new JSZip();
      for (let i = 0; i < bulkSongs.length; i += 1) {
        const song = bulkSongs[i];
        const png = await QRCode.toDataURL(JSON.stringify(song), {
          width: 700,
          margin: 4,
          errorCorrectionLevel: 'M',
          color: { dark: '#000000', light: '#FFFFFF' },
        });
        const fileName = `QR_${String(i + 1).padStart(4, '0')}_${nombreQRSeguro(song.artist)}_${nombreQRSeguro(song.title)}.png`;
        zip.file(fileName, png.substring(png.indexOf(',') + 1), { base64: true });
        if ((i + 1) % 10 === 0 || i === bulkSongs.length - 1) {
          setBulkProgress(Math.round(((i + 1) / bulkSongs.length) * 85));
          // Cede tiempo a la interfaz para mostrar el porcentaje en archivos grandes.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      setBulkStatus('Comprimiendo ZIP...');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => {
        setBulkProgress(85 + Math.round(metadata.percent * 0.15));
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Hitster_Pro_YouTube_${bulkSongs.length}_QR.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setBulkProgress(100);
      setBulkStatus(`¡Listo! Se descargaron ${bulkSongs.length} códigos QR dentro del ZIP.`);
    } catch (error) {
      setBulkStatus(`No se pudo preparar el ZIP: ${error?.message || 'error desconocido'}.`);
    } finally {
      setBulkBusy(false);
    }
  };

  // Genera el QR con los datos que el escáner existente necesita.
  const handleGenerateQR = (event) => {
    event.preventDefault();
    const youtubeId = extractYouTubeID(formData.youtubeId);
    if (!youtubeId) {
      setQrError('El enlace de YouTube no es válido. Revisa el link e inténtalo otra vez.');
      setQrSong(null);
      return;
    }
    setQrError('');
    setQrSong({
      year: String(formData.year).trim(),
      artist: formData.artist.trim(),
      title: formData.title.trim(),
      youtubeId,
    });
  };

  // Guarda un PNG con fondo blanco, margen y resolución alta para diseñar tarjetas.
  const handleDownloadQR = () => {
    if (!qrSong || !qrCanvasRef.current) return;
    try {
      const canvas = qrCanvasRef.current;
      const png = canvas.toDataURL('image/png');
      const clean = (value) => String(value)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '').slice(0, 45);
      const filename = `QR_${clean(qrSong.artist)}_${clean(qrSong.title)}.png`;
      const link = document.createElement('a');
      link.href = png;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setQrError('No se pudo descargar la imagen. Prueba desde Chrome o Safari.');
    }
  };

  const handleNewQR = () => {
    setFormData({ title: '', artist: '', year: '', youtubeId: '' });
    setQrSong(null);
    setQrError('');
  };

  const updateField = (key, value) => {
    setFormData((previous) => ({ ...previous, [key]: value }));
    // Evita descargar por accidente un QR que corresponda a datos anteriores.
    setQrSong(null);
    setQrError('');
  };

  // Un único lector para toda la sesión: no se desmonta al abrir una canción.
  // El navegador decide si recuerda el permiso entre visitas o recargas.
  const handleScan = useCallback((result, error) => {
    if (viewRef.current !== 'scanner') return;
    if (error) {
      if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) {
        setScannerError('Autoriza la cámara en los permisos de este sitio. Para que el navegador lo recuerde, selecciona «Permitir» de forma permanente si aparece esa opción.');
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
      setPlayerReady(false);
      setPlayerError('');
      setView('player');
      viewRef.current = 'player';
    } catch {
      setScannerError('El código escaneado no es una tarjeta de Hitster Pro.');
    }
  }, []);

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

  const startPlaying = () => {
    if (isRevealed) return;
    setPlayerError('');
    setIsPlaying(true);
  };

  const stopPlaying = () => {
    setIsPlaying(false);
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = null;
  };

  const togglePlay = () => isPlaying ? stopPlaying() : startPlaying();

  const handleActuallyPlaying = () => {
    // El contador comienza cuando YouTube inicia el audio, no mientras carga.
    setIsPlaying(true);
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = setTimeout(() => {
      setIsPlaying(false);
    }, 30000);
  };

  useEffect(() => () => {
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
  }, []);

  const openScanner = () => {
    songAlreadyScannedRef.current = false;
    setScannerInitialized(true);
    setScannerError(
      typeof window !== 'undefined' && !window.isSecureContext
        ? 'Abre el juego desde un sitio HTTPS (o localhost). En HTTP la cámara puede estar bloqueada.'
        : ''
    );
    setView('scanner');
  };

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
          <button onClick={() => { setCreatorMode('single'); setView('creator'); }} className="flex items-center justify-center gap-3 bg-gray-800 hover:bg-gray-700 text-white p-6 rounded-2xl text-xl font-bold border border-gray-700 shadow-lg">
            <PlusCircle size={28} /> Crear códigos QR
          </button>
        </div>
      )}

      {/* La cámara conserva su instancia mientras esta pestaña está abierta.
          Al salir de Escanear se oculta, pero no se vuelve a solicitar getUserMedia.
          Permanece activa durante la sesión para evitar nuevos avisos del navegador. */}
      {scannerInitialized && (
        <div
          aria-hidden={view !== 'scanner'}
          className={view === 'scanner'
            ? 'w-full max-w-md flex flex-col items-center z-10'
            : 'fixed left-[-10000px] top-0 w-80 h-80 opacity-0 pointer-events-none overflow-hidden'
          }
        >
          {view === 'scanner' && (
            <>
              <h2 className="text-2xl font-bold mb-4">Apunta al QR</h2>
              <p className="text-gray-300 text-sm mb-3">Enfoca el código QR dentro del recuadro.</p>
            </>
          )}
          <div className="w-full aspect-square bg-gray-800 rounded-3xl overflow-hidden border-4 border-green-500 shadow-2xl relative">
            <QrReader
              videoId="hitster-camera-video"
              onResult={handleScan}
              constraints={CAMERA_CONSTRAINTS}
              scanDelay={300}
              containerStyle={CAMERA_CONTAINER_STYLE}
              videoContainerStyle={CAMERA_VIDEO_CONTAINER_STYLE}
              videoStyle={CAMERA_VIDEO_STYLE}
            />
            {view === 'scanner' && (
              <div className="pointer-events-none absolute inset-8 border-4 border-yellow-400 rounded-2xl z-20" />
            )}
          </div>
          {view === 'scanner' && (
            <>
              {scannerError && (
                <div role="alert" className="w-full bg-red-900/80 border border-red-400 rounded-xl p-4 text-sm mt-4">
                  {scannerError}
                </div>
              )}
              <button onClick={() => setView('menu')} className="mt-8 text-gray-400 hover:text-white underline font-medium">Volver al menú</button>
            </>
          )}
        </div>
      )}

      {view === 'creator' && (
        <div className="w-full max-w-md bg-gray-800 p-6 rounded-2xl shadow-xl z-10">
          <h2 className="text-2xl font-black text-yellow-400 text-center mb-2">Generar códigos QR</h2>
          <p className="text-gray-300 text-sm text-center mb-6">
            Crea un QR individual o importa todas tus canciones desde Excel para descargarlas juntas en un ZIP.
          </p>


          <div className="flex gap-2 mb-6 border-b border-gray-600 pb-3">
            <button type="button" disabled={bulkBusy} onClick={() => setCreatorMode('single')}
              className={`flex-1 rounded-xl p-3 font-bold ${creatorMode === 'single' ? 'bg-yellow-500 text-black' : 'bg-gray-700 text-white'}`}>
              Una canción
            </button>
            <button type="button" disabled={bulkBusy} onClick={() => setCreatorMode('excel')}
              className={`flex-1 rounded-xl p-3 font-bold ${creatorMode === 'excel' ? 'bg-yellow-500 text-black' : 'bg-gray-700 text-white'}`}>
              Desde Excel
            </button>
          </div>
          {creatorMode === 'single' ? (
            <>
          <form onSubmit={handleGenerateQR} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-200">
              Año de lanzamiento
              <input required type="number" placeholder="Ej. 1998" className="p-3 bg-gray-700 rounded-lg text-white"
                value={formData.year} onChange={(e) => updateField('year', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-200">
              Artista
              <input required type="text" placeholder="Ej. Shakira" className="p-3 bg-gray-700 rounded-lg text-white"
                value={formData.artist} onChange={(e) => updateField('artist', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-200">
              Nombre de la canción
              <input required type="text" placeholder="Ej. Ciega, sordomuda" className="p-3 bg-gray-700 rounded-lg text-white"
                value={formData.title} onChange={(e) => updateField('title', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-gray-200">
              Enlace de YouTube
              <input required type="text" placeholder="Pega el link del video" className="p-3 bg-gray-700 rounded-lg text-white"
                value={formData.youtubeId} onChange={(e) => updateField('youtubeId', e.target.value)} />
            </label>
            <button type="submit" className="bg-yellow-500 hover:bg-yellow-600 text-black font-black p-4 rounded-xl mt-2">
              GENERAR QR
            </button>
          </form>

          {qrError && (
            <p role="alert" className="mt-4 text-red-200 bg-red-950 border border-red-600 rounded-lg p-3 text-sm">{qrError}</p>
          )}

          {qrSong && (
            <div className="mt-7 border-t border-gray-600 pt-6 flex flex-col items-center gap-4">
              <p className="text-green-400 font-bold text-center">¡Tu QR está listo!</p>
              {/* El archivo descargado contiene solo el QR en negro sobre blanco. */}
              <div className="bg-white rounded-xl p-3 flex items-center justify-center">
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
              <p className="text-sm text-gray-300 text-center">
                {qrSong.artist} — {qrSong.title} ({qrSong.year})
              </p>
              <button type="button" onClick={handleDownloadQR}
                className="w-full bg-green-500 hover:bg-green-600 text-white font-black p-4 rounded-xl flex items-center justify-center gap-2">
                <Download size={23} /> DESCARGAR QR EN PNG
              </button>
              <button type="button" onClick={handleNewQR}
                className="w-full p-3 rounded-lg border border-gray-500 hover:bg-gray-700 font-semibold">
                Crear otro QR
              </button>
            </div>
          )}


            </>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="bg-blue-950/60 border border-blue-500/70 rounded-xl p-4">
                <h3 className="font-black text-blue-200 text-lg mb-2">Importar muchas canciones</h3>
                <p className="text-sm text-gray-200">
                  Copia desde Excel las 4 columnas: <strong>Año | Artista | Canción | Enlace YouTube</strong>.
                  También puedes subir el archivo .xlsx directamente.
                </p>
              </div>
              <label className="block text-sm font-bold text-gray-100">
                OPCIÓN 1 — Pegar todas las filas desde Excel
                <textarea
                  value={bulkPaste}
                  onChange={(event) => { setBulkPaste(event.target.value); setBulkSongs([]); setBulkStatus(''); setBulkFileName(''); }}
                  disabled={bulkBusy}
                  rows={6}
                  placeholder={'Año\tArtista\tCanción\tEnlace YouTube\n1976\tABBA\tDancing Queen\thttps://www.youtube.com/watch?v=...'}
                  className="mt-2 w-full p-3 bg-gray-700 rounded-xl text-white text-sm resize-y"
                />
              </label>
              <button type="button" onClick={importBulkPaste} disabled={bulkBusy || !bulkPaste.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold p-4 rounded-xl">
                CARGAR CANCIONES PEGADAS
              </button>
              <div className="flex items-center gap-3 text-gray-400 text-sm font-semibold">
                <span className="flex-1 border-t border-gray-600"/>O TAMBIÉN<span className="flex-1 border-t border-gray-600"/>
              </div>
              <label className="block text-sm font-bold text-gray-100">
                OPCIÓN 2 — Seleccionar archivo Excel (.xlsx)
                <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={bulkBusy}
                  onChange={(event) => { void importBulkExcel(event.target.files?.[0]); event.target.value = ''; }}
                  className="mt-2 w-full p-3 bg-gray-700 rounded-xl text-white" />
              </label>
              {bulkFileName && <p className="text-sm text-gray-300">Origen: {bulkFileName}</p>}
              {bulkStatus && <p role="status" className="p-3 bg-gray-700 rounded-xl text-sm text-gray-100">{bulkStatus}</p>}
              {bulkWarnings.length > 0 && (
                <div className="bg-yellow-950/60 p-3 rounded-xl text-sm text-yellow-100">
                  <p className="font-bold">Filas omitidas: {bulkWarnings.length}</p>
                  {bulkWarnings.slice(0, 8).map((warning, i) => <p key={i}>{warning}</p>)}
                </div>
              )}
              {bulkBusy && <p className="text-center text-yellow-300 font-bold">Generando QR: {bulkProgress}%</p>}
              <button type="button" onClick={downloadBulkQrs} disabled={!bulkSongs.length || bulkBusy}
                className="w-full bg-green-500 hover:bg-green-600 disabled:opacity-40 text-white font-black p-4 rounded-xl flex items-center justify-center gap-2">
                <Download size={22} /> DESCARGAR TODOS LOS QR ({bulkSongs.length}) EN ZIP
              </button>
              <p className="text-xs text-gray-400 text-center">Se descarga un solo ZIP con una imagen PNG por canción. No se crean tarjetas ni PDF.</p>
            </div>
          )}
          <button onClick={() => setView('menu')} className="w-full text-center mt-6 text-sm text-gray-400 hover:text-white underline">
            Volver al menú
          </button>
        </div>
      )}

      {/* El reproductor de YouTube se mantiene montado detrás de un fondo 100% opaco.
          No usar display:none ni visibility:hidden: algunos navegadores bloquean el audio. */}
      {view === 'player' && currentSong && (
        <div className="w-full max-w-md relative isolate overflow-hidden rounded-3xl bg-gray-950 border border-gray-700 shadow-2xl min-h-120 z-10">
          <div className="absolute top-0 left-0 z-0 pointer-events-none" aria-hidden="true" style={{ width: 240, height: 200 }}>
            <ReactPlayer
              ref={playerRef}
              src={`https://www.youtube.com/watch?v=${currentSong.youtubeId}`}
              playing={isPlaying}
              onReady={() => { setPlayerReady(true); setPlayerError(''); }}
              onDurationChange={handleDurationChange}
              onPlaying={handleActuallyPlaying}
              onPause={() => { if (playTimerRef.current) clearTimeout(playTimerRef.current); playTimerRef.current = null; setIsPlaying(false); }}
              onEnded={stopPlaying}
              onError={() => { setPlayerError('No se pudo reproducir esta canción. Prueba otra tarjeta.'); stopPlaying(); }}
              controls={false}
              width="240px"
              height="200px"
              playsInline={true}
              volume={1}
              muted={false}
              config={{ youtube: { playsinline: 1, rel: 0 } }}
            />
          </div>

          {/* Esta capa opaca impide que se vea cualquier imagen o título de YouTube. */}
          <div className="absolute inset-0 z-10 bg-gray-950 pointer-events-none" aria-hidden="true" />

          <div className="relative z-20 min-h-120 w-full flex flex-col items-center justify-center p-8">
            <h2 className="text-xl text-gray-300 font-semibold mb-6 text-center">
              {isRevealed ? 'Respuesta revelada' : 'Escucha y adivina la canción'}
            </h2>
            <div
              className={`relative flex items-center justify-center w-48 h-48 rounded-full bg-black border-4 border-gray-700 shadow-[0_0_30px_rgba(0,0,0,0.5)] mb-6 transition-transform duration-1000 ${isPlaying ? 'animate-spin' : ''}`}
              style={{ animationDuration: '3s' }}
            >
              <div className="absolute w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center">
                <div className="w-4 h-4 bg-gray-900 rounded-full" />
              </div>
            </div>
            <button
              onClick={togglePlay}
              disabled={isRevealed}
              aria-label={isPlaying ? 'Pausar canción' : 'Reproducir canción'}
              className="w-20 h-20 bg-green-500 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-full flex items-center justify-center shadow-lg transition active:scale-95 mb-4"
            >
              {isPlaying ? <Pause size={36} className="text-white" /> : <Play size={36} className="text-white ml-2" />}
            </button>
            {!isRevealed && (
              <p className="text-sm text-gray-300 mb-6 text-center" role={playerError ? 'alert' : undefined}>
                {playerError || (playerReady ? 'Presiona Play para escuchar 30 segundos.' : 'Cargando canción...')}
              </p>
            )}
            {isRevealed && (
              <div className="w-full text-center mb-6">
                <div className="text-6xl font-black text-yellow-400 mb-2 drop-shadow-lg">{currentSong.year}</div>
                <h3 className="text-2xl font-bold text-white">{currentSong.title}</h3>
                <p className="text-lg text-gray-300">{currentSong.artist}</p>
              </div>
            )}
            {!isRevealed && (
              <button
                onClick={() => { setIsRevealed(true); stopPlaying(); }}
                className="w-full py-4 bg-yellow-500 hover:bg-yellow-600 text-black font-black text-xl rounded-xl flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={24} /> REVELAR RESPUESTA
              </button>
            )}
            <button onClick={() => { setView('menu'); stopPlaying(); }} className="mt-8 text-sm text-gray-400 hover:text-white transition-colors">
              Escanear otra tarjeta
            </button>
          </div>
        </div>
      )}
    </div>
  );
}