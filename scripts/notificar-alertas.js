// Roda uma vez por dia via GitHub Actions (.github/workflows/notificacoes-diarias.yml) —
// sem precisar de Firebase Cloud Functions nem do plano Blaze. Usa uma Service Account do
// Firebase (chave de admin) guardada como secret do repositório, nunca commitada.
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const NOTIF_DIAS_ANTECEDENCIA = 5;

// Mesma regra do app (ver index.html, calcularAlertas()): dias até a data, hoje = 0.
function diasAteData(dataStr, hojeStr){
  const d1 = new Date(hojeStr + 'T00:00:00');
  const d2 = new Date(dataStr + 'T00:00:00');
  return Math.round((d2 - d1) / 86400000);
}

// Porta apenas a parte estável da lógica de alertas do app: dívidas, provisões e
// orçamento. Faturas de cartão ficam de fora por enquanto — a lógica de agrupamento de
// fatura (cartoesAgrupados() no index.html) é complexa e não foi portada sem poder testar
// contra dados reais; incluí-la sem validação arriscaria notificação com valor errado.
//
// Cada alerta leva uma "chave" estável (baseada no id do lançamento/provisão, ou no mês+
// categoria do orçamento) — é isso que permite ao main() saber quais já foram avisados
// antes, em vez de mandar push repetido todo dia até a data vencer.
function calcularAlertasDoUsuario(data, hojeStr){
  const alertas = [];

  (data.lancamentos || []).filter(l => l.tipo === 'divida' && Number(l.parcelas) > 0 && l.vencimento).forEach(l => {
    const dias = diasAteData(l.vencimento, hojeStr);
    if(dias <= NOTIF_DIAS_ANTECEDENCIA){
      alertas.push({
        chave: `divida:${l.id}`,
        texto: `Parcela de dívida (${l.descricao || 'Dívida'}) vence em ${dias} dia(s)`,
        urgente: dias < 0
      });
    }
  });

  (data.provisoes || []).forEach(p => {
    if(!p.vencimento) return;
    const dias = diasAteData(p.vencimento, hojeStr);
    if(dias <= NOTIF_DIAS_ANTECEDENCIA){
      const rotulo = p.tipo === 'receita' ? 'Receita prevista' : (p.tipo === 'cartao' ? 'Compra prevista no cartão' : 'Despesa prevista');
      const alvo = p.tipo === 'cartao' ? (p.nomeCartao || p.categoria) : p.categoria;
      alertas.push({
        chave: `provisao:${p.id}`,
        texto: `${rotulo} (${alvo || 'sem categoria'}) vence em ${dias} dia(s)`,
        urgente: dias < 0
      });
    }
  });

  const monthKey = hojeStr.slice(0, 7);
  const orc = (data.orcamentos || {})[monthKey];
  if(orc){
    const itens = (data.lancamentos || []).filter(l =>
      (l.tipo === 'cartao' || l.tipo === 'despesa') &&
      l.categoria !== 'Cartão de Crédito' &&
      l.data && l.data.slice(0, 7) === monthKey
    );
    const gastoPorCat = {};
    itens.forEach(l => {
      const cat = l.categoria || 'Outros';
      gastoPorCat[cat] = (gastoPorCat[cat] || 0) + Number(l.valor);
    });
    Object.keys(orc.categorias || {}).forEach(cat => {
      const limite = orc.categorias[cat];
      const gasto = gastoPorCat[cat] || 0;
      if(limite > 0 && gasto > limite){
        alertas.push({ chave: `orcamento:${monthKey}:${cat}`, texto: `Orçamento de ${cat} ultrapassado`, urgente: true });
      }
    });
    const gastoTotal = Object.values(gastoPorCat).reduce((s, v) => s + v, 0);
    if(orc.total > 0 && gastoTotal > orc.total){
      alertas.push({ chave: `orcamento-total:${monthKey}`, texto: 'Orçamento total do mês ultrapassado', urgente: true });
    }
  }

  return alertas;
}

// Decide quais alertas merecem push hoje: os que nunca foram avisados, e os que
// "pioraram" (venceram desde o último aviso) — para o usuário saber que passou a estar
// vencido, mesmo já tendo visto o aviso de "vence em X dias" antes.
function selecionarNovidades(alertas, jaNotificados){
  return alertas.filter(a => {
    const anterior = jaNotificados[a.chave];
    if(!anterior) return true;
    return a.urgente && !anterior.urgente;
  });
}

async function main(){
  const hojeStr = new Date().toISOString().slice(0, 10);
  const usuariosSnap = await db.collection('usuarios').get();

  for(const usuarioDoc of usuariosSnap.docs){
    const uid = usuarioDoc.id;
    const data = usuarioDoc.data();
    const alertas = calcularAlertasDoUsuario(data, hojeStr);

    const notifRef = db.collection('usuarios').doc(uid).collection('push').doc('notificados');
    const notifSnap = await notifRef.get();
    const jaNotificados = notifSnap.exists ? (notifSnap.data().alertas || {}) : {};

    // Atualiza o registro pra refletir o estado de hoje: mantém só as chaves que ainda
    // existem (uma dívida paga ou provisão excluída "libera" a chave), e guarda se cada
    // alerta está urgente — é essa comparação que permite reavisar quando algo vence.
    const novoRegistro = {};
    alertas.forEach(a => { novoRegistro[a.chave] = { urgente: a.urgente }; });
    if(JSON.stringify(novoRegistro) !== JSON.stringify(jaNotificados)){
      await notifRef.set({ alertas: novoRegistro, atualizadoEm: new Date().toISOString() }, { merge: true });
    }

    const novidades = selecionarNovidades(alertas, jaNotificados);
    if(novidades.length === 0) continue;

    const tokensDoc = await db.collection('usuarios').doc(uid).collection('push').doc('tokens').get();
    const tokens = tokensDoc.exists ? (tokensDoc.data().tokens || []) : [];
    if(tokens.length === 0) continue;

    const urgentes = novidades.filter(a => a.urgente).length;
    const corpo = novidades.length === 1
      ? novidades[0].texto
      : `${novidades.length} novo(s) alerta(s)${urgentes ? ` (${urgentes} vencido(s))` : ''} — abra o Broto para ver.`;

    const resposta = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: 'Broto', body: corpo },
      webpush: { fcmOptions: { link: '/' } }
    });

    // Remove tokens inválidos (app desinstalado, permissão revogada, etc.) pra não
    // acumular lixo na lista e tentar enviar pra eles pra sempre.
    const tokensInvalidos = [];
    resposta.responses.forEach((r, i) => {
      if(!r.success && r.error && (
        r.error.code === 'messaging/registration-token-not-registered' ||
        r.error.code === 'messaging/invalid-registration-token'
      )){
        tokensInvalidos.push(tokens[i]);
      }
    });
    if(tokensInvalidos.length > 0){
      await db.collection('usuarios').doc(uid).collection('push').doc('tokens').update({
        tokens: admin.firestore.FieldValue.arrayRemove(...tokensInvalidos)
      });
    }

    console.log(`Broto: ${novidades.length} alerta(s) novo(s) enviados para usuário ${uid}, ${resposta.successCount}/${tokens.length} entregues.`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Falha ao enviar notificações:', err);
  process.exit(1);
});
