export function handleBlockInput(value: string): number | null {
    const height = Number.parseInt(value.replace(/\D/g, '').slice(0, 6), 10);
    return Number.isNaN(height) ? null : height;
}
