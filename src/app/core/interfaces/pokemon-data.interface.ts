export interface PokemonData {
    aliases: string[],
    turnsOnField: number,
    kills: number,
    supportMoves: number,
    overallUtility: {
        [gameUrl: string]: GameStats
    }
}

export interface GameStats {
    offensiveness?: number,
    supportivness?: number,
    damageDone?: number,
    kills?: number,
    turnsOnField?: number
}