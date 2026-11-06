/* =====================================================================
   Geoteste — função de rotas para a margem de obra.
   Caminho no repositório: netlify/functions/rota.mjs

   A extensão .mjs é de propósito: ela diz ao Netlify que o arquivo é
   um módulo moderno. Com .js, o Netlify só aceita isso se houver
   "type": "module" no package.json — e aí quebraria calado.

   Faz o mesmo que o fxRotaKm do seu Excel: Nominatim converte o nome da
   cidade em coordenadas, OSRM calcula a rota rodoviária até lá. A origem
   é sempre Contagem-MG.

   Está no servidor, e não no painel, por um motivo: o Nominatim pede que
   quem consulta se identifique no cabeçalho User-Agent, e navegador não
   deixa definir esse cabeçalho. Aqui a identificação vai certa e o ritmo
   de uma consulta por segundo é respeitado.

   Variáveis de ambiente que a função usa (já existem no seu Netlify):
     SUPABASE_URL          ex.: https://xxxx.supabase.co
     SUPABASE_SERVICE_KEY  a chave secreta — nunca sai daqui

   Como chamar:
     /.netlify/functions/rota?cidade=Patrocínio-MG   -> resolve uma cidade
     /.netlify/functions/rota?pendentes=1            -> resolve as que faltam
     /.netlify/functions/rota?pendentes=1&limite=6   -> quantas por chamada
   ===================================================================== */

const ORIGEM = "Contagem-MG";
const AGENTE = "Geoteste-Margem/1.0 (controle interno de margem de obra)";
const PAUSA  = 1100;                    // ms entre consultas ao Nominatim
const LIMITE_PADRAO = 6;                // cidades por chamada, para caber no tempo

const espera = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Supabase, pela API REST, com a chave de serviço ---------- */
function supa(){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if(!url || !key) throw new Error("faltam SUPABASE_URL ou SUPABASE_SERVICE_KEY no Netlify");
  const cab = {apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json"};
  return {
    async get(caminho){
      const r = await fetch(`${url}/rest/v1/${caminho}`, {headers: cab});
      if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      return r.json();
    },
    async rpc(nome, args){
      const r = await fetch(`${url}/rest/v1/rpc/${nome}`, {
        method: "POST", headers: cab, body: JSON.stringify(args || {}),
      });
      if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
      return r.json();
    },
    async upsert(tabela, linhas, conflito){
      const r = await fetch(`${url}/rest/v1/${tabela}?on_conflict=${conflito}`, {
        method: "POST",
        headers: {...cab, Prefer: "resolution=merge-duplicates,return=minimal"},
        body: JSON.stringify(linhas),
      });
      if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    },
  };
}

/* ---------- Nominatim: nome da cidade -> coordenadas ---------- */
async function coordenadas(cidade){
  /* «São Paulo-SP» vira «São Paulo, SP, Brasil», que é o que o Nominatim entende */
  const corte = cidade.lastIndexOf("-");
  const nome = corte > 0 ? cidade.slice(0, corte) : cidade;
  const uf   = corte > 0 ? cidade.slice(corte + 1) : "";
  const busca = `${nome}, ${uf}, Brasil`.replace(/, ,/g, ",");
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", busca);
  u.searchParams.set("format", "json");
  u.searchParams.set("limit", "1");
  u.searchParams.set("countrycodes", "br");
  const r = await fetch(u, {headers: {"User-Agent": AGENTE, "Accept-Language": "pt-BR"}});
  if(!r.ok) throw new Error(`Nominatim ${r.status}`);
  const d = await r.json();
  if(!d || !d.length) throw new Error("cidade não encontrada");
  return {lon: Number(d[0].lon), lat: Number(d[0].lat)};
}

/* ---------- OSRM: km rodoviários entre dois pontos ---------- */
async function rodoviario(a, b){
  const u = `https://router.project-osrm.org/route/v1/driving/`
          + `${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  const r = await fetch(u, {headers: {"User-Agent": AGENTE}});
  if(!r.ok) throw new Error(`OSRM ${r.status}`);
  const d = await r.json();
  if(d.code !== "Ok" || !d.routes || !d.routes.length) throw new Error("rota não encontrada");
  return Math.round(d.routes[0].distance / 100) / 10;      // metros -> km, uma casa
}

let origemCache = null;
async function pontoOrigem(){
  if(!origemCache) origemCache = await coordenadas(ORIGEM);
  return origemCache;
}

async function resolve(cidade){
  const o = await pontoOrigem();
  await espera(PAUSA);
  const d = await coordenadas(cidade);
  return rodoviario(o, d);
}

/* ---------- quem ainda não tem km ----------
   O distinct é feito no banco, de propósito. Lendo a tabela de produção
   direto, o Supabase devolveria no máximo 1.000 linhas, e nas primeiras
   1.000 só aparecem umas 20 cidades — as demais sumiriam em silêncio.
   A função margem_cidades_pendentes() devolve as ~150 e pronto. */
async function pendentes(sb){
  const linhas = await sb.rpc("margem_cidades_pendentes");
  return (linhas || []).map(l => (l.cidade || "").trim()).filter(Boolean);
}

export default async (req) => {
  const resposta = (corpo, codigo = 200) => new Response(JSON.stringify(corpo, null, 1),
    {status: codigo, headers: {"Content-Type": "application/json; charset=utf-8",
                               "Access-Control-Allow-Origin": "*"}});
  try{
    const p = new URL(req.url).searchParams;
    const sb = supa();

    /* uma cidade só */
    if(p.get("cidade")){
      const cidade = p.get("cidade").trim();
      try{
        const km = await resolve(cidade);
        await sb.upsert("margem_distancias",
          [{cidade, km, origem_calculo: "api", erro: "", atualizado_em: new Date().toISOString()}],
          "cidade");
        return resposta({cidade, km});
      }catch(e){
        await sb.upsert("margem_distancias",
          [{cidade, km: null, origem_calculo: "api", erro: String(e.message || e),
            atualizado_em: new Date().toISOString()}], "cidade");
        return resposta({cidade, erro: String(e.message || e)}, 422);
      }
    }

    /* a fila das que faltam */
    if(p.get("pendentes")){
      const limite = Math.min(Number(p.get("limite")) || LIMITE_PADRAO, 12);
      const fila = await pendentes(sb);
      const feitas = [], falhas = [];
      for(const cidade of fila.slice(0, limite)){
        try{
          const km = await resolve(cidade);
          feitas.push({cidade, km});
        }catch(e){ falhas.push({cidade, erro: String(e.message || e)}); }
      }
      const agora = new Date().toISOString();
      if(feitas.length) await sb.upsert("margem_distancias",
        feitas.map(f => ({...f, origem_calculo: "api", erro: "", atualizado_em: agora})), "cidade");
      if(falhas.length) await sb.upsert("margem_distancias",
        falhas.map(f => ({cidade: f.cidade, km: null, origem_calculo: "api",
                          erro: f.erro, atualizado_em: agora})), "cidade");
      return resposta({resolvidas: feitas.length, comErro: falhas.length,
                       restam: Math.max(0, fila.length - limite), feitas, falhas});
    }

    return resposta({erro: "use ?cidade=Nome-UF ou ?pendentes=1"}, 400);
  }catch(e){
    return resposta({erro: String(e.message || e)}, 500);
  }
};
