export type ClassValue = string | number | boolean | null | undefined;

export function cn(...inputs: ClassValue[]) {
    return inputs.filter(Boolean).join(' ');
}
