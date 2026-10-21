const hosts=new Set(['hst-api.wialon.com','hst-api.wialon.us']);
export function normalizeWialonUnit(item,now=Date.now()){
  if(!Number.isSafeInteger(item.id)||item.id<=0||typeof item.nm!=='string')return null;
  const p=item.pos,valid=p&&Number.isFinite(p.x)&&Math.abs(p.x)<=180&&Number.isFinite(p.y)&&Math.abs(p.y)<=90&&Number.isFinite(p.t)&&p.t>0&&p.t*1000<=now+60000;
  return {external_id:String(item.id),name:item.nm.slice(0,100),imei:typeof item.uid==='string'&&/^\d{15}$/.test(item.uid)?item.uid:null,
    position:valid?{lat:p.y,lon:p.x,recorded_at:new Date(p.t*1000).toISOString(),speed:Number.isFinite(p.s)&&p.s>=0?p.s:null,altitude:Number.isFinite(p.z)?p.z:null,heading:Number.isFinite(p.c)&&p.c>=0&&p.c<=360?p.c:null}:null};
}
export function createWialonClient({token=process.env.WIALON_TOKEN||'',endpoint=process.env.WIALON_API_URL||'https://hst-api.wialon.com/wialon/ajax.html',fetcher=fetch,now=()=>Date.now()}={}){
  let pending;
  const configured=()=>!!token;
  async function rpc(svc,params,sid){
    const u=new URL(endpoint);if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.pathname!=='/wialon/ajax.html'||u.username||u.password||u.search||u.hash||(u.port&&u.port!=='443'))throw Error('Servidor Wialon no permitido.');
    const response=await fetcher(u.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({svc,params:JSON.stringify(params),...(sid?{sid}:{})})});
    if(!response.ok)throw Error('Wialon no respondió correctamente.');
    let text='',size=0;const decoder=new TextDecoder();for await(const chunk of response.body){size+=chunk.byteLength;if(size>5*1024*1024)throw Error('Respuesta Wialon demasiado grande.');text+=decoder.decode(chunk,{stream:true});}
    const data=JSON.parse(text+decoder.decode());if(data.error)throw Error('Wialon rechazó la consulta (código '+Number(data.error)+').');return data;
  }
  async function fetchUnits(){
    if(!configured())throw Object.assign(Error('Falta configurar WIALON_TOKEN en el servidor.'),{status:409});
    let sid;try{
      const session=await rpc('token/login',{token,fl:1});sid=session.eid;if(typeof sid!=='string'||sid.length>256)throw Error('Sesión Wialon inválida.');
      const units=[];for(let from=0;from<10000;from+=250){
        const page=await rpc('core/search_items',{spec:{itemsType:'avl_unit',propName:'sys_name',propValueMask:'*',sortType:'sys_name',propType:'property'},force:1,flags:1281,from,to:from+249},sid);
        if(!Array.isArray(page.items)||!Number.isInteger(page.totalItemsCount)||page.totalItemsCount<0||page.totalItemsCount>10000)throw Error('Listado Wialon inválido o superior a 10.000 unidades.');
        units.push(...page.items.map(item=>normalizeWialonUnit(item,now())).filter(Boolean));if(from+page.items.length>=page.totalItemsCount)break;if(page.items.length===0)throw Error('Paginación Wialon incompleta.');
      }return [...new Map(units.map(u=>[u.external_id,u])).values()];
    }catch(error){if(error.status===409)throw error;throw Object.assign(Error('No se pudo sincronizar Wialon. Revisá el servidor, el token y sus permisos de lectura.'),{status:502});}
    finally{if(sid)await rpc('core/logout',{},sid).catch(()=>{});}
  }
  return {configured,units(){if(!pending)pending=fetchUnits().finally(()=>{pending=null;});return pending;}};
}
