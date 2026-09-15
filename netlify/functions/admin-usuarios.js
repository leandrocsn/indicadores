/* ============================================================
   Criar e excluir acessos. Roda no servidor porque precisa da chave secreta
   do Supabase — a que ignora as regras de acesso. O navegador nunca a vê.
   Antes de qualquer coisa, confere no servidor se quem pediu é administrador:
   esconder o botão na tela não protege nada.
   ============================================================ */
const URL_SB    = process.env.SUPABASE_URL;
const SEGREDO   = process.env.SUPABASE_SERVICE_KEY;
const PAPEIS_OK = ["admin", "gestao", "consulta"];
 
const resposta = (codigo, corpo) => ({
  statusCode: codigo,
  headers: {"Content-Type": "application/json; charset=utf-8"},
  body: JSON.stringify(corpo)
});
 
const adm = (caminho, opcoes = {}) => fetch(URL_SB + caminho, {
  ...opcoes,
  headers: {
    apikey: SEGREDO,
    Authorization: "Bearer " + SEGREDO,
    "Content-Type": "application/json",
    ...(opcoes.headers || {})
  }
});
 
/* senha provisória legível, para quando o convite por e-mail não servir */
function senhaProvisoria(){
  const letras = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for(let i = 0; i < 12; i++) s += letras[Math.floor(Math.random() * letras.length)];
  return s;
}
 
exports.handler = async (evento) => {
  if(evento.httpMethod !== "POST") return resposta(405, {erro: "método não permitido"});
  if(!URL_SB || !SEGREDO) return resposta(500, {erro: "o servidor não está configurado (faltam as variáveis de ambiente)"});
 
  /* ---------- quem está pedindo? ---------- */
  const cab = evento.headers.authorization || evento.headers.Authorization || "";
  const token = cab.replace(/^Bearer\s+/i, "").trim();
  if(!token) return resposta(401, {erro: "sessão não enviada"});
 
  const rUser = await fetch(URL_SB + "/auth/v1/user", {
    headers: {apikey: SEGREDO, Authorization: "Bearer " + token}
  });
  if(!rUser.ok) return resposta(401, {erro: "sessão inválida ou expirada"});
  const usuario = await rUser.json();
 
  /* ---------- essa pessoa é administradora? ---------- */
  const rPerfil = await adm(`/rest/v1/perfis?user_id=eq.${usuario.id}&select=papel,ativo`);
  const perfis = rPerfil.ok ? await rPerfil.json() : [];
  const perfil = perfis[0];
  if(!perfil || !perfil.ativo || perfil.papel !== "admin")
    return resposta(403, {erro: "só o administrador pode gerenciar acessos"});
 
  let corpo = {};
  try { corpo = JSON.parse(evento.body || "{}"); } catch(e){ return resposta(400, {erro: "pedido malformado"}); }
 
  /* ---------- criar acesso ---------- */
  if(corpo.acao === "convidar"){
    const email = String(corpo.email || "").trim().toLowerCase();
    const nome  = String(corpo.nome || "").trim();
    const papel = PAPEIS_OK.includes(corpo.papel) ? corpo.papel : "consulta";
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return resposta(400, {erro: "e-mail inválido"});
 
    let novoId = null, senha = null;
 
    if(corpo.sem_email){
      senha = senhaProvisoria();
      const r = await adm("/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({email, password: senha, email_confirm: true, user_metadata: {nome}})
      });
      const d = await r.json();
      if(!r.ok) return resposta(400, {erro: d.msg || d.message || d.error_description || "não consegui criar o usuário"});
      novoId = d.id;
    }else{
      /* para onde o link do convite devolve a pessoa. Explícito aqui para não
         depender do Site URL configurado no Supabase. */
      const destino = process.env.SITE_URL || process.env.URL
        || evento.headers.origin || evento.headers.Origin || "";
      const r = await adm("/auth/v1/invite"
        + (destino ? "?redirect_to=" + encodeURIComponent(destino) : ""), {
        method: "POST",
        body: JSON.stringify({email, data: {nome}})
      });
      const d = await r.json();
      if(!r.ok){
        const m = d.msg || d.message || d.error_description || "";
        if(/email|smtp|rate/i.test(m))
          return resposta(400, {erro: "o Supabase não conseguiu enviar o e-mail (" + m
            + "). Marque a opção de senha provisória e tente de novo."});
        return resposta(400, {erro: m || "não consegui enviar o convite"});
      }
      novoId = d.id;
    }
 
    /* o gatilho do banco já criou o perfil; aqui só se ajusta papel, nome e liberação */
    if(novoId){
      await adm(`/rest/v1/perfis?user_id=eq.${novoId}`, {
        method: "PATCH",
        headers: {Prefer: "return=minimal"},
        body: JSON.stringify({papel, nome, email, ativo: true})
      });
    }
    return resposta(200, {ok: true, senha_provisoria: senha});
  }
 
  /* ---------- excluir acesso ---------- */
  if(corpo.acao === "excluir"){
    const id = String(corpo.user_id || "");
    if(!/^[0-9a-f-]{36}$/i.test(id)) return resposta(400, {erro: "identificador inválido"});
    if(id === usuario.id) return resposta(400, {erro: "você não pode excluir o próprio acesso"});
    const r = await adm("/auth/v1/admin/users/" + id, {method: "DELETE"});
    if(!r.ok){
      const d = await r.json().catch(() => ({}));
      return resposta(400, {erro: d.msg || d.message || "não consegui excluir"});
    }
    return resposta(200, {ok: true});
  }
 
  return resposta(400, {erro: "ação desconhecida"});
};
