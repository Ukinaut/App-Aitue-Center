// Geometrías de áreas publicadas: nunca se deduce un perímetro a partir de la magnitud.
export function areaGeometry(input){
  if(!input||!['Polygon','MultiPolygon'].includes(input.type))return null;
  if(input.type==='MultiPolygon'&&(!Array.isArray(input.coordinates)||!input.coordinates.length||input.coordinates.length>2000))return null;
  let count=0;
  const polygon=rings=>{
    if(!Array.isArray(rings)||!rings.length||rings.length>2000)throw Error('Polígono inválido');
    return rings.map(ring=>{
      if(!Array.isArray(ring)||ring.length<4)throw Error('Anillo inválido');
      const points=ring.map(p=>{if(++count>60000||!Array.isArray(p)||p.length<2||!p.slice(0,2).every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90)throw Error('Coordenadas inválidas');return p.slice(0,2);});
      if(points[0][0]!==points.at(-1)[0]||points[0][1]!==points.at(-1)[1])throw Error('Anillo abierto');
      return points;
    });
  };
  try{return {type:input.type,coordinates:input.type==='Polygon'?polygon(input.coordinates):input.coordinates.map(polygon)};}catch{return null;}
}
// Un área que cruza ±180° se dibuja a ambos bordes, sin atravesar todo el mapa.
export function mapAreaCopies(geometry){
  const valid=areaGeometry(geometry);if(!valid)return [];
  const polygons=valid.type==='Polygon'?[valid.coordinates]:valid.coordinates;
  const result=[];
  for(const polygon of polygons){
    const outer=polygon[0];let last=outer[0][0];
    const unwrap=(ring,reference)=>ring.map(([lon,lat],i)=>{let x=lon;const target=i?last:reference;while(x-target>180)x-=360;while(x-target< -180)x+=360;last=x;return [x,lat];});
    const rings=[unwrap(outer,outer[0][0])];
    for(const hole of polygon.slice(1)){last=rings[0][0][0];rings.push(unwrap(hole,last));}
    const xs=rings[0].map(p=>p[0]),min=Math.min(...xs),max=Math.max(...xs);
    for(const shift of [0,...(max>180?[-360]:[]),...(min< -180?[360]:[])])result.push({type:'Polygon',coordinates:rings.map(r=>r.map(([x,y])=>[x+shift,y]))});
  }
  return result;
}
export function areaCenter(geometry){
  const copy=mapAreaCopies(geometry)[0];if(!copy)return null;
  const ring=copy.coordinates[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);
  const lon=(Math.min(...xs)+Math.max(...xs))/2;
  return {lat:(Math.min(...ys)+Math.max(...ys))/2,lon:((lon+180)%360+360)%360-180};
}
