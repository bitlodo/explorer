/** Shared geometry contracts for the official neighborhood map. */
export interface NeighborhoodRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface NeighborhoodSlot extends NeighborhoodRect {
    crown: number;
    side: 'center' | 'north' | 'east' | 'south' | 'west';
}
