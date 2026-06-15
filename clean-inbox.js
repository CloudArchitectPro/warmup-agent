require('dotenv').config();
const { ImapFlow } = require('imapflow');

async function clean() {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: 'nuvatron@gmail.com', pass: process.env.IMAP_PASSWORD_CLOUMA_COM }, logger: false
  });
  await client.connect();
  
  const domains = ['clouma.com','nuvatron.com','medicalbrothers.com','naveen.cloud','xaipex.com','santhigiri.org','tharunmoorthy.com','nimbusnebula.com','flippyfly.com','indxpro.com','examtraps.com'];
  
  const lock = await client.getMailboxLock('INBOX');
  let total = 0;
  try {
    for (const domain of domains) {
      const found = await client.search({ from: '@' + domain });
      for (const uid of found) {
        await client.messageMove(uid, '[Gmail]/Trash', { uid: true });
        total++;
      }
    }
    console.log('Moved to trash: ' + total + ' emails');
  } finally {
    lock.release();
    await client.logout();
  }
}
clean();
