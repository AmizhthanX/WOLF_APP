namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>
/// Media Foundation identifiers, written out once.
///
/// These are stable, documented constants. Naming them here rather than inline keeps the
/// encoder readable and means a typo shows up as a compile error at one site rather than as
/// a silently ignored attribute — Media Foundation accepts unknown attribute GUIDs without
/// complaint, so a mistyped one produces an encoder that quietly ignores its bitrate.
/// </summary>
internal static class MfGuids
{
    // Categories and major types.
    public static readonly Guid VideoEncoderCategory = new("f79eac7d-e545-4387-bdee-d647d7bde42a");
    public static readonly Guid MajorTypeVideo = new("73646976-0000-0010-8000-00aa00389b71");

    // Subtypes. Media Foundation builds these from a FOURCC plus a fixed suffix.
    public static readonly Guid VideoFormatH264 = FromFourCc("H264");
    public static readonly Guid VideoFormatHevc = FromFourCc("HEVC");
    public static readonly Guid VideoFormatNv12 = FromFourCc("NV12");

    // Media type attributes.
    public static readonly Guid MtMajorType = new("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    public static readonly Guid MtSubtype = new("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    public static readonly Guid MtAvgBitrate = new("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    public static readonly Guid MtFrameSize = new("1652c33d-d6b2-4012-b834-72030849a37d");
    public static readonly Guid MtFrameRate = new("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    public static readonly Guid MtPixelAspectRatio = new("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    public static readonly Guid MtInterlaceMode = new("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    public static readonly Guid MtMpeg2Profile = new("ad76a80b-2d5c-4e0b-b375-64e520137036");
    public static readonly Guid MtAllSamplesIndependent = new("c9173739-5e56-461c-b713-46fb995cb95f");

    /// <summary>SPS and PPS for the stream, available once the output type is set.</summary>
    public static readonly Guid MtMpegSequenceHeader = new("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");

    // Transform attributes.
    public static readonly Guid TransformAsync = new("f81a699a-649a-497d-8c73-29f8fed6ad7a");
    public static readonly Guid TransformAsyncUnlock = new("e5666d6b-3422-4eb6-a421-da7db1f8e207");
    public static readonly Guid SaD3D11Aware = new("206b4fc8-fcf9-4c51-afe3-9764369e33a0");
    public static readonly Guid LowLatency = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    public static readonly Guid FriendlyName = new("314ffbae-5b41-4c95-9c19-4e7d586face3");

    // Sample attributes.
    /// <summary>Present and non-zero on a key frame.</summary>
    public static readonly Guid SampleCleanPoint = new("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");

    // Codec API properties. These are set through ICodecAPI, never through the transform's
    // attribute store: IMFAttributes accepts any GUID and returns success, so a codec
    // property set there is discarded in silence.
    public static readonly Guid AvEncCommonRateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423");
    public static readonly Guid AvEncCommonMeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52");
    public static readonly Guid AvEncVideoForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345");
    /// <summary>Pictures between key frames. The property H.264 encoders honour for GOP length.</summary>
    public static readonly Guid AvEncMpvGopSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1");

    // Enumeration flags for MFTEnumEx.
    public const int EnumFlagSyncMft = 0x00000001;
    public const int EnumFlagAsyncMft = 0x00000002;
    public const int EnumFlagHardware = 0x00000004;
    public const int EnumFlagSortAndFilter = 0x00000040;

    // Media event types the async transform model uses.
    public const int TransformNeedInput = 601;
    public const int TransformHaveOutput = 602;
    public const int TransformDrainComplete = 603;

    /// <summary>MF_EVENT_FLAG_NO_WAIT: poll rather than block.</summary>
    public const int EventFlagNoWait = 0x00000001;

    /// <summary>MF_E_NO_EVENTS, returned when polling finds nothing queued.</summary>
    public const int NoEvents = unchecked((int)0xC00D3E80);

    /// <summary>MF_E_TRANSFORM_NEED_MORE_INPUT: the encoder has produced all it can for now.</summary>
    public const int TransformNeedMoreInput = unchecked((int)0xC00D6D72);

    /// <summary>MF_E_TRANSFORM_STREAM_CHANGE: the output type changed and must be renegotiated.</summary>
    public const int TransformStreamChange = unchecked((int)0xC00D6D61);

    /// <summary>Rate control mode: constant bitrate, which is what a live stream wants.</summary>
    public const uint RateControlModeCbr = 0;

    /// <summary>MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.</summary>
    public const int OutputStreamProvidesSamples = 0x00000100;

    /// <summary>MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.</summary>
    public const int OutputStreamCanProvideSamples = 0x00000200;

    /// <summary>H.264 profiles, as MF_MT_MPEG2_PROFILE values.</summary>
    public const uint H264ProfileBaseline = 66;
    public const uint H264ProfileMain = 77;
    public const uint H264ProfileHigh = 100;

    private static Guid FromFourCc(string fourCc)
    {
        uint value = (uint)(fourCc[0] | (fourCc[1] << 8) | (fourCc[2] << 16) | (fourCc[3] << 24));
        return new Guid(value, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71);
    }

    /// <summary>Pack a width and height into the single 64-bit value MF_MT_FRAME_SIZE wants.</summary>
    public static ulong PackSize(int width, int height) => ((ulong)(uint)width << 32) | (uint)height;

    /// <summary>Pack a rational into the 64-bit form MF_MT_FRAME_RATE wants.</summary>
    public static ulong PackRatio(int numerator, int denominator) =>
        ((ulong)(uint)numerator << 32) | (uint)denominator;
}
