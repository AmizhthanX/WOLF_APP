package app.amizhthan.wolf

/** The phone test build talks to what the release does: the production API, over TLS. See `src/release`. */
internal object ApiEndpoint {
    const val BASE_URL = "https://api.amizhthan.app"

    /** The realtime relay, for signaling only. Media never goes through it. */
    const val REALTIME_URL = "wss://relay.amizhthan.app"
}
