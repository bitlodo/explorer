export default function MapStatus({ text }: { text: string }) {
    if (!text) return null;
    return <div className="absolute left-4 top-4 flex h-auto w-auto flex-col items-end gap-2 border-0 text-white pointer-events-auto">
        {text}
    </div>;
}
