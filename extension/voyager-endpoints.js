// Endpoints Voyager (API interne de LinkedIn, non documentée).
// Ils changent sans prévenir, surtout les "decorationId" et les "queryId".
// Pour les mettre à jour : active le mode Capture dans la popup, fais l'action
// à la main sur linkedin.com, puis copie l'URL et le corps capturés ici.

export const ENDPOINTS = {
  // Ton propre profil (sert à connaître ton identifiant pour la messagerie)
  me: '/voyager/api/me',

  // Profil par identifiant public, via GraphQL (relevé au mode capture le 28/10/2026)
  profileGraphql: (publicId) =>
    `/voyager/api/graphql?includeWebMetadata=true&variables=(memberIdentity:${encodeURIComponent(publicId)})` +
    '&queryId=voyagerIdentityDashProfiles.273a499c117721535e6da078bee17e9c',

  // Profil par identifiant public, ancien endpoint REST (secours)
  profileByPublicId: (publicId) =>
    `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}`,

  // Page HTML du profil, utilisée en secours pour retrouver l'URN fsd_profile
  profileHtml: (publicId) => `/in/${encodeURIComponent(publicId)}/`,

  // Invitation avec note optionnelle (relevé au mode capture le 28/10/2026)
  sendInvite:
    '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2' +
    '&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-3',

  // Invitations envoyées encore en attente
  sentInvitations: (count = 50) =>
    `/voyager/api/relationships/sentInvitationViewsV2?count=${count}&invitationType=CONNECTION&q=invitationType&start=0`,

  // Dernières relations acceptées (sert à détecter les acceptations)
  recentConnections: (count = 40) =>
    '/voyager/api/relationships/dash/connections' +
    '?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16' +
    `&count=${count}&q=search&sortType=RECENTLY_ADDED&start=0`,

  // Envoi d'un message à une relation (confirmé au mode capture le 28/10/2026)
  sendMessage: '/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage',

  // Boîte de réception principale (relevé au mode capture le 28/10/2026)
  conversations: (mailboxUrn, count = 20) =>
    '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf' +
    `&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:${count},mailboxUrn:${encodeURIComponent(mailboxUrn)})`,

  // Recherche de conversations par mot-clé (nom du prospect, entreprise)
  searchConversations: (mailboxUrn, keywords, count = 20) =>
    '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.737b27144cf922499202658a5345016f' +
    `&variables=(categories:List(INBOX,SPAM,ARCHIVE),count:${count},firstDegreeConnections:false,` +
    `mailboxUrn:${encodeURIComponent(mailboxUrn)},keywords:${encodeURIComponent(keywords)})`,

  // Messages d'une conversation
  messages: (conversationUrn) =>
    '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.5846eeb71c981f11e0134cb6626cc314' +
    `&variables=(conversationUrn:${encodeURIComponent(conversationUrn)})`
};

// Construit le corps d'une invitation
export function inviteBody(profileUrn, note) {
  const body = { invitee: { inviteeUnion: { memberProfile: profileUrn } } };
  if (note) body.customMessage = note;
  return body;
}

// Construit le corps d'un message (trackingId = 16 octets aléatoires, comme le client web)
export function messageBody(myProfileUrn, recipientUrn, text) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const trackingId = String.fromCharCode(...bytes);
  return {
    message: {
      body: { attributes: [], text },
      originToken: crypto.randomUUID(),
      renderContentUnions: []
    },
    mailboxUrn: myProfileUrn,
    trackingId,
    dedupeByClientGeneratedToken: false,
    hostRecipientUrns: [recipientUrn]
  };
}
