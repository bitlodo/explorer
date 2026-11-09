import { useState } from 'react';
import MapCanvas from './map/MapCanvas';
import MapUI from './MapUI';
import type { MapControls } from './map/MapControls';

function App() {
    const [map, setMap] = useState<MapControls | null>(null);
    return (
        <div className='atlas-app'>
            <MapCanvas onReady={setMap} className="atlas-map" />
            {map && <MapUI map={map} />}
        </div>
    );
}

export default App
