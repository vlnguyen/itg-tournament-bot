import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';

const webDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web/dist',
);

/**
 * Serves the built Vite output. `exclude` keeps this from swallowing `/api`
 * and websocket routes once those exist — see DESIGN.md, "Deployment": one
 * process serves the API, websockets, and the static build together.
 */
@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: webDist,
      exclude: ['/api/{*path}'],
    }),
  ],
})
export class StaticModule {}
