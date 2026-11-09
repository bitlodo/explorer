import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { handleBlockInput } from '@/lib/formValidation';
import { Loader2Icon } from 'lucide-react';

export default function MapSearch({ ready, onSearch }: {
    ready: boolean;
    onSearch: (height: number) => Promise<void>;
}) {
    const [bitmap, setBitmap] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const valid = bitmap !== null && ready && !loading;

    async function submit() {
        if (!valid) return;
        setLoading(true);
        try { await onSearch(bitmap); }
        finally { setLoading(false); }
    }

    return <div className="absolute right-4 top-4 flex w-60 flex-col items-end justify-end pointer-events-auto">
        <div className="flex w-full flex-row items-center justify-end gap-2">
            <Input id="name" value={bitmap ?? ''} className="h-9 w-24 rounded-sm p-2"
                disabled={loading} autoFocus placeholder="block #" autoComplete="off"
                onChange={event => setBitmap(handleBlockInput(event.target.value))}
                onKeyDown={event => { if (event.key === 'Enter') void submit(); }} />
            <Button disabled={!valid} onClick={() => void submit()} className="inline-flex h-9 w-24 rounded-sm bg-orange-500 hover:bg-orange-400">
                {loading ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin" /> : 'Search'}
            </Button>
        </div>
    </div>;
}
