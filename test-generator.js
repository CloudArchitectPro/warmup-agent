require('dotenv').config();
const { generateEmail } = require('./generator');

async function test() {
  console.log('Testing DeepSeek email generator...\n');
  
  try {
    const result = await generateEmail({
      senderEmail: 'test@example.com',
      receiverEmail: 'client@example.com',
      senderNiche: 'SaaS marketing automation',
      receiverNiche: 'E-commerce retail'
    });
    
    console.log('✅ Email generated successfully!\n');
    console.log('📧 SUBJECT:', result.subject);
    console.log('\n📝 BODY:\n', result.body);
    console.log('\n' + '='.repeat(50));
    console.log('✨ DeepSeek is working perfectly!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.data);
    }
  }
}

test();
