import { useState } from 'react';
import MapCanvas from './map/MapCanvas';
import MapUI from './MapUI';
import type { MapControls } from './map/MapControls';

function App() {
    const [map, setMap] = useState<MapControls | null>(null);
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    return (
        <div className='w-screen h-screen flex flex-col items-center'>
            {isMobile ? (
                <div className='w-full h-full bg-black text-white flex text-center items-center justify-center'>
                    <p>This application <br /> is only supported on desktop.</p>
                </div>
            ) : (
                <div className='atlas-app'>
                    <MapCanvas onReady={setMap} className="atlas-map" />
                    {map && <MapUI map={map} />}
                </div>
            )}
        </div>
    )
}

export default App
