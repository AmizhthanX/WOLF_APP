package app.amizhthan.wolf

/** Release builds talk only to the production API, over TLS. */
internal object ApiEndpoint {
    const val BASE_URL = "https://api.amizhthan.app"

    /** The realtime relay, for signaling only. Media never goes through it. */
    const val REALTIME_URL = "wss://relay.amizhthan.app"
}
