import { createApp } from './app.js';
import { config } from './config/index.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`[thuanhung_tkb] listening on http://localhost:${config.port}`);
});
