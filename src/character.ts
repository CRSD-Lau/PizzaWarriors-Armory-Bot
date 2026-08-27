export function formatCharacterSpecialization(primarySpec?: string, className?: string): string | undefined {
  const specialization = primarySpec?.trim();
  if (!specialization) return undefined;

  const characterClass = className?.trim();
  if (!characterClass || specialization.toLowerCase().endsWith(characterClass.toLowerCase())) {
    return specialization;
  }

  return `${specialization} ${characterClass}`;
}
