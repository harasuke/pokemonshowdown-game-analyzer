import { PokemonData } from "./pokemon-data.interface";

export interface PlayerTeam {
    [pokemonName: string]: PokemonData
}