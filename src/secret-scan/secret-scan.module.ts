import { Module } from '@nestjs/common';
import { SecretScanner } from './secret-scanner.js';

/** Spec 4 (LW4): the secret scanner, used by the scanning wrappers of the two ports and by the steps. */
@Module({
  providers: [SecretScanner],
  exports: [SecretScanner],
})
export class SecretScanModule {}
