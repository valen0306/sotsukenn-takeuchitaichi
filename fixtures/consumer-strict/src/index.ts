import { foo } from "lib-no-types";

// Without a .d.ts for "lib-no-types", this should trigger TS7016 in strict consumer.
const x: number = foo;
void x;


