import { Layer } from 'effect';
import { Command } from './services/command';

export const AppLive = Layer.mergeAll(Command.layer);
