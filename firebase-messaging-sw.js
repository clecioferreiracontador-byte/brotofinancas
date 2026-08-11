importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAJ1PcQ060jbMMRyt1Xk26oEEAKGOX23Io",
  authDomain: "planilha-financeira-bd3ae.firebaseapp.com",
  projectId: "planilha-financeira-bd3ae",
  storageBucket: "planilha-financeira-bd3ae.firebasestorage.app",
  messagingSenderId: "613906881186",
  appId: "1:613906881186:web:6f645aab1283d3f82c55fb"
});

const messaging = firebase.messaging();

// Mostra a notificação do sistema quando o app está fechado/em segundo plano.
// Com o app aberto em primeiro plano, o FCM não passa por aqui — quem trata é o
// messaging.onMessage() dentro do index.html.
messaging.onBackgroundMessage(function(payload){
  const titulo = (payload.notification && payload.notification.title) || 'Broto';
  const opcoes = {
    body: (payload.notification && payload.notification.body) || '',
    icon: 'icons/icon-192.png?v=5',
    badge: 'icons/icon-192.png?v=5',
    data: payload.data || {}
  };
  self.registration.showNotification(titulo, opcoes);
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function(clientList){
      for(const client of clientList){
        if('focus' in client) return client.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
