/***********************************************************************************
 * TFG Jarilla 2025 — Cálculo de índices espectrales Sentinel-2 (Google Earth Engine)
 * NDVI y NDII (pre-fuego) + NBR pre/post y dNBR (severidad post-fuego)
 *
 * Autor: Luis Hernández  |  Caso: Incendio de Jarilla (ignición 12-13 ago 2025)
 *
 * QUÉ HACE ESTE SCRIPT
 *   1. Construye dos composites Sentinel-2 L2A sin nubes: PRE-fuego y POST-fuego.
 *   2. Calcula NDVI y NDII sobre el composite PRE (estado del combustible previo).
 *   3. Calcula NBR pre y post y la diferencia dNBR (severidad), escalada x1000.
 *   4. Clasifica el dNBR en las clases de severidad de Key & Benson (2006).
 *   5. Exporta los rásters (GeoTIFF, EPSG:25830) a Google Drive.
 *   6. Imprime en consola las ESTADÍSTICAS que se necesitan para redactar los resultados
 *      (percentiles de NDVI/NDII y superficie por clase de severidad).
 *
 * CÓMO USARLO
 *   a) Subir el perímetro del incendio como asset (Shapefile -> Assets -> Table).
 *      Pegar su ruta en la variable PERIMETRO de abajo.
 *      (Si no se sube, se usa un rectángulo aproximado SOLO como prueba.)
 *   b) Revisar las ventanas de fechas PRE y POST y el umbral de nubes.
 *   c) Run. Mirar la consola (pestaña Console) y lanzar las tareas (pestaña Tasks).
 ***********************************************************************************/
 
// ============================ 0. PARÁMETROS EDITABLES ============================
 
// --- Perímetro del incendio (subir shapefile como asset y poner aquí la ruta) ---
var USAR_ASSET = true;                          // true si se ha subido el perímetro
var PERIMETRO_ASSET = 'users/LHernandezS/incendio_jarilla';   
 
// Rectángulo de respaldo (aprox.) por si aún no se ha subido el perímetro (lon/lat)
var BBOX_RESPALDO = ee.Geometry.Rectangle([-6.30, 40.05, -5.75, 40.40]);
 
// --- Ventanas temporales (cloud-free composite por mediana) ---
// PRE-fuego: vegetación en su estado previo, antes de la ignición (12 ago).
var PRE_INI  = '2025-07-15';
var PRE_FIN  = '2025-08-11';
// POST-fuego: tras el paso del frente. Controlado el 24 ago; se busca escena
// despejada que conserve la señal de carbón antes de lluvias/rebrote.
var POST_INI = '2025-08-25';
var POST_FIN = '2025-09-30';
 
// --- Enmascarado de nubes ---
var MAX_NUBES = 60;        // % nubosidad máx. por escena (filtro grueso de metadatos)
var USAR_CSPLUS = true;    // true = usar Cloud Score+ (recomendado, más robusto)
var CS_UMBRAL = 0.60;      // umbral de 'claridad' Cloud Score+ (0-1; >0.6 conserva claro)
 
// --- Salida ---
var EPSG = 'EPSG:25830';   // ETRS89 / UTM 30N (igual que la topografía del tfg)
var ESCALA = 20;           // 20 m: resolución nativa de SWIR (B11/B12). NDVI nativo 10 m.
var CARPETA_DRIVE = 'TFG_Jarilla_Sentinel2';
 
// ===============================================================================
 
 
// ============================ 1. ÁREA DE ESTUDIO ===============================
var aoi = USAR_ASSET ? ee.FeatureCollection(PERIMETRO_ASSET).geometry()
                     : BBOX_RESPALDO;
Map.centerObject(aoi, 11);
Map.addLayer(aoi, {color: 'black'}, 'Perímetro', false);
 
 
// ====================== 2. COLECCIÓN Y MÁSCARA DE NUBES ========================
// Sentinel-2 L2A (reflectancia de superficie, armonizada).
function cargarS2(ini, fin) {
  var col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
              .filterBounds(aoi)
              .filterDate(ini, fin)
              .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', MAX_NUBES));
 
  if (USAR_CSPLUS) {
    var csp = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    col = col.linkCollection(csp, ['cs']);
    col = col.map(function(img) {
      var clara = img.select('cs').gte(CS_UMBRAL);
      return img.updateMask(clara)
                .divide(10000)                 // a reflectancia 0-1
                .copyProperties(img, img.propertyNames());
    });
  } else {
    // Máscara con la banda SCL (Scene Classification Layer) de L2A.
    col = col.map(function(img) {
      var scl = img.select('SCL');
      // Conserva: 4 veg, 5 suelo desnudo, 6 agua, 7 sin clasificar, 11 nieve.
      var buena = scl.eq(4).or(scl.eq(5)).or(scl.eq(6)).or(scl.eq(7)).or(scl.eq(11));
      return img.updateMask(buena)
                .divide(10000)
                .copyProperties(img, img.propertyNames());
    });
  }
  return col;
}
 
var s2pre  = cargarS2(PRE_INI,  PRE_FIN);
var s2post = cargarS2(POST_INI, POST_FIN);
print('Nº escenas PRE  disponibles:', s2pre.size());
print('Nº escenas POST disponibles:', s2post.size());
 
// Composite por mediana (robusto frente a nubes/sombras residuales).
var pre  = s2pre.median().clip(aoi);
var post = s2post.median().clip(aoi);
 
 
// ============================ 3. ÍNDICES ESPECTRALES ===========================
// Bandas Sentinel-2: B4 rojo (10 m), B8 NIR (10 m), B11 SWIR1 (20 m), B12 SWIR2 (20 m).
function ndvi(img){ return img.normalizedDifference(['B8','B4']).rename('NDVI'); }   // (NIR-Rojo)/(NIR+Rojo)
function ndii(img){ return img.normalizedDifference(['B8','B11']).rename('NDII'); }  // (NIR-SWIR1)/(NIR+SWIR1)
function nbr (img){ return img.normalizedDifference(['B8','B12']).rename('NBR'); }   // (NIR-SWIR2)/(NIR+SWIR2)
 
// --- Estado del combustible PREVIO (apartado 5.3) ---
var NDVI_pre = ndvi(pre);
var NDII_pre = ndii(pre);
 
// --- Severidad (apartado 5.5) ---
var NBR_pre  = nbr(pre);
var NBR_post = nbr(post);
var dNBR = NBR_pre.subtract(NBR_post).multiply(1000).rename('dNBR');  // escala Key & Benson
 
// Clasificación de severidad (Key & Benson, 2006), dNBR x1000:
//  < -100 : rebrote acentuado | -100..99 : no quemado | 100..269 : baja
//  270..439 : moderada-baja  | 440..659 : moderada-alta | >=660 : alta
var severidad = dNBR
  .where(dNBR.lt(-100), 1)
  .where(dNBR.gte(-100).and(dNBR.lt(100)), 2)
  .where(dNBR.gte(100).and(dNBR.lt(270)), 3)
  .where(dNBR.gte(270).and(dNBR.lt(440)), 4)
  .where(dNBR.gte(440).and(dNBR.lt(660)), 5)
  .where(dNBR.gte(660), 6)
  .rename('severidad');
 
 
// ============================ 4. VISUALIZACIÓN ================================
Map.addLayer(NDVI_pre, {min:0, max:0.9, palette:['white','khaki','green']}, 'NDVI pre');
Map.addLayer(NDII_pre, {min:-0.2, max:0.5, palette:['brown','white','blue']}, 'NDII pre');
Map.addLayer(dNBR, {min:-100, max:1000, palette:['green','yellow','orange','red','purple']}, 'dNBR');
var palSev = ['1b9e77','c2c2c2','ffffb2','fecc5c','fd8d3c','e31a1c'];
Map.addLayer(severidad, {min:1, max:6, palette:palSev}, 'Severidad (Key&Benson)');
 
 
// ====================== 5. ESTADÍSTICAS PARA LA REDACCIÓN =====================
// 5.1 Percentiles de NDVI y NDII previos (caracterización del combustible).
var percentiles = ee.Reducer.percentile([5,10,25,50,75,90,95])
                    .combine(ee.Reducer.mean(), '', true)
                    .combine(ee.Reducer.stdDev(), '', true);
var statsNDVI = NDVI_pre.reduceRegion({reducer:percentiles, geometry:aoi, scale:ESCALA, maxPixels:1e13, bestEffort:true});
var statsNDII = NDII_pre.reduceRegion({reducer:percentiles, geometry:aoi, scale:ESCALA, maxPixels:1e13, bestEffort:true});
print('--- NDVI pre (estadísticos) ---', statsNDVI);
print('--- NDII pre (estadísticos) ---', statsNDII);
 
// 5.2 Superficie por clase de severidad (ha). Área de píxel en m2 -> ha.
var areaImg = ee.Image.pixelArea().divide(10000).addBands(severidad);
var areaPorClase = areaImg.reduceRegion({
  reducer: ee.Reducer.sum().group({groupField:1, groupName:'clase_severidad'}),
  geometry: aoi, scale: ESCALA, maxPixels: 1e13, bestEffort:true
});
print('--- Superficie (ha) por clase de severidad ---', areaPorClase);
 
// 5.3 Estadísticos del dNBR continuo.
var statsdNBR = dNBR.reduceRegion({
  reducer: ee.Reducer.percentile([5,25,50,75,95]).combine(ee.Reducer.mean(),'',true),
  geometry: aoi, scale: ESCALA, maxPixels: 1e13, bestEffort:true});
print('--- dNBR (estadísticos) ---', statsdNBR);
 
 
// ============================ 6. EXPORTACIONES ================================
// Rásters a Drive en EPSG:25830 para los mapas (QGIS) y para cruzar con topografía.
function exportar(img, nombre){
  Export.image.toDrive({
    image: img.toFloat(), description: nombre, folder: CARPETA_DRIVE,
    fileNamePrefix: nombre, region: aoi, scale: ESCALA, crs: EPSG, maxPixels: 1e13
  });
}
exportar(NDVI_pre, 'jarilla_NDVI_pre');
exportar(NDII_pre, 'jarilla_NDII_pre');
exportar(NBR_pre,  'jarilla_NBR_pre');
exportar(NBR_post, 'jarilla_NBR_post');
exportar(dNBR,     'jarilla_dNBR');
exportar(severidad,'jarilla_severidad');
 
print('>>> Revisar la pestaña TASKS y pulsa RUN en cada exportación.');
