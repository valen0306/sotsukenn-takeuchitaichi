import { getX } from "test-lib";

const x = getX();
// The repair loop should end up selecting a return type that has `.foo`.
const y: number = x.foo;
void y;


