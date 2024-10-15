const { MongoClient } = require('mongodb');
require('dotenv-flow').config({ silent: true });

main();

async function main() {
  try {
    const url = process.env.ORFARCHIV_DB_URL?.trim() || 'mongodb://localhost';
    const client = await MongoClient.connect(url);
    const newsCollection = client.db('orfarchiv').collection('news');
    const count = await newsCollection.countDocuments();
    console.log(count);
    process.exit(0);
  } catch (error) {
    console.log(error.message);
    process.exit(1);
  }
}
