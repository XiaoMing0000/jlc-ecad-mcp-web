/** Read `--name value` or `--name=value` from an argv array. */
export function readOptionValue(argument: string, name: string, argv: string[], index: number): { value: string; index: number } | null {
  if (argument === name) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return null;
    }
    return { value, index: index + 1 };
  }

  const value = argument.slice(name.length + 1);
  return value === '' ? null : { value, index };
}
