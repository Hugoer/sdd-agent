// Spec 11 (SD12): every skill needs a valid Agent Skills header. Test step skills and repo skills get one here.

/** A `SKILL.md` whose header passes SD12's check when `name` is its folder's name. */
export function skillMd(
  name: string,
  body: string,
  description = `Test skill ${name}.`,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}
