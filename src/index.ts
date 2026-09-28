import { NodeRuntime, NodeServices } from '@effect/platform-node';
import dotenv from 'dotenv-flow';
import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';
import { version } from '../package.json';
import { mainCommand } from './commands';
import { AppLive } from './layers';
import { logCause, LoggerLive } from './shared/logger';

dotenv.config({ silent: true });

Command.run(mainCommand, { version }).pipe(
  Effect.provide(AppLive),
  Effect.provide(NodeServices.layer),
  Effect.catchCause((cause) =>
    logCause(cause).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(LoggerLive),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
